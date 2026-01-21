/***********************************************************************
 * Claude MCP for Obsidian – main.ts
 *
 * 1. `npm i ws node-pty @types/ws @types/node --save`
 * 2. Compile with the normal Obsidian plugin build pipeline
 **********************************************************************/
import { Plugin, Notice, WorkspaceLeaf, addIcon } from "obsidian";
import { McpDualServer } from "./src/mcp/dual-server";
import { WorkspaceManager } from "./src/obsidian/workspace-manager";
import {
	ClaudeCodeSettings,
	DEFAULT_SETTINGS,
	ClaudeCodeSettingTab,
} from "./src/settings";
import claudeLogo from "./assets/claude-logo.png";

export default class ClaudeMcpPlugin extends Plugin {
	public mcpServer!: McpDualServer;
	private workspaceManager!: WorkspaceManager;
	public settings!: ClaudeCodeSettings;
	private terminalRibbonIcon: HTMLElement | null = null;

	// Multi-terminal support
	private usedTerminalIds: Set<number> = new Set();
	private lastFocusedTerminalLeaf: WorkspaceLeaf | null = null;
	private static readonly MAX_TERMINALS = 10;

	/* ---------------- core lifecycle ---------------- */

	async onload() {
		// Load settings
		await this.loadSettings();

		// Register custom Claude icon
		addIcon(
			"claude-logo",
			`<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
				<image href="${claudeLogo}" width="16" height="16" />
			</svg>`
		);

		// Conditionally initialize terminal features (lazy-loaded to save resources)
		if (this.settings.enableEmbeddedTerminal) {
			await this.initializeTerminalFeatures();
		}

		// Add settings tab
		this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));

		// Initialize workspace manager first
		this.workspaceManager = new WorkspaceManager(this.app, this, {
			onSelectionChange: (notification) => {
				this.mcpServer?.broadcast(notification);
			},
		});

		// Initialize dual server (WebSocket + HTTP/SSE)
		await this.initializeMcpServer();

		this.workspaceManager.setupListeners();
	}

	onunload() {
		this.mcpServer?.stop();
		this.removeTerminalRibbonIcon();
	}

	async initializeMcpServer(): Promise<void> {
		try {
			// Initialize dual server (WebSocket + HTTP/SSE)
			this.mcpServer = new McpDualServer({
				app: this.app,
				workspaceManager: this.workspaceManager,
				wsPort: undefined, // Use random port for WebSocket
				httpPort: this.settings.mcpHttpPort,
				enableWebSocket: this.settings.enableWebSocketServer,
				enableHttp: this.settings.enableHttpServer,
			});

			// Start services
			const serverInfo = await this.mcpServer.start();
			console.debug(`[MCP] Dual server started:`, serverInfo);

			// Update lock file with workspace path
			const basePath =
				(this.app.vault.adapter as any).getBasePath?.() ||
				process.cwd();
			console.debug(`[MCP] Vault base path: ${basePath}`);
			this.mcpServer.updateWorkspaceFolders(basePath);
			
			// Validate tool registration
			this.mcpServer.validateToolRegistration();

			// Show success notification
			const wsStatus = serverInfo.wsPort
				? `WebSocket: ${serverInfo.wsPort}`
				: "WebSocket: disabled";
			const httpStatus = serverInfo.httpPort
				? `HTTP: ${serverInfo.httpPort}`
				: "HTTP: disabled";
			new Notice(`Claude MCP running - ${wsStatus}, ${httpStatus}`);
		} catch (error) {
			console.error("[MCP] Failed to start server:", error);

			// Handle specific error types
			if (
				error.message?.includes("EADDRINUSE") ||
				error.name === "PortInUseError"
			) {
				// Enhanced message for port conflicts, especially multiple vaults
				new Notice(
					`Port ${this.settings.mcpHttpPort} is already in use. This might be because:\n` +
						`• Another Obsidian vault is running this plugin\n` +
						`• Another application is using this port\n\n` +
						`Please configure a different port in Settings → Community Plugins → Claude Code.`,
					10000
				);
			} else if (
				error.message?.includes("EACCES") ||
				error.name === "PermissionError"
			) {
				new Notice(
					`Permission denied for port ${this.settings.mcpHttpPort}. ` +
						`Try using a port above 1024 in Settings → Community Plugins → Claude Code.`,
					8000
				);
			} else {
				new Notice(
					`Failed to start MCP server: ${error.message}`,
					8000
				);
			}
		}
	}

	async restartMcpServer(): Promise<void> {
		try {
			// Stop existing server
			if (this.mcpServer) {
				console.debug("[MCP] Stopping server for restart...");
				this.mcpServer.stop();
			}

			// Small delay to ensure clean shutdown
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Restart server with new settings
			await this.initializeMcpServer();
		} catch (error) {
			console.error("[MCP] Failed to restart server:", error);

			// Handle specific error types
			if (
				error.message?.includes("EADDRINUSE") ||
				error.name === "PortInUseError"
			) {
				new Notice(
					`Port ${this.settings.mcpHttpPort} is already in use. This might be because:\n` +
						`• Another Obsidian vault is running this plugin\n` +
						`• Another application is using this port\n\n` +
						`Please configure a different port in Settings → Community Plugins → Claude Code.`,
					10000
				);
			} else if (
				error.message?.includes("EACCES") ||
				error.name === "PermissionError"
			) {
				new Notice(
					`Permission denied for port ${this.settings.mcpHttpPort}. ` +
						`Try using a port above 1024 in Settings → Community Plugins → Claude Code.`,
					8000
				);
			} else {
				new Notice(
					`Failed to restart MCP server: ${error.message}`,
					8000
				);
			}
		}
	}

	/* ---------------- terminal management ---------------- */

	public addTerminalRibbonIcon(): void {
		if (!this.terminalRibbonIcon) {
			this.terminalRibbonIcon = this.addRibbonIcon(
				"claude-logo",
				"Claude Terminal (Click: toggle, Ctrl/Cmd+Click: new)",
				(evt: MouseEvent) => {
					if (evt.ctrlKey || evt.metaKey) {
						this.newClaudeTerminal();
					} else {
						this.toggleClaudeTerminal();
					}
				}
			);
		}
	}

	public removeTerminalRibbonIcon(): void {
		if (this.terminalRibbonIcon) {
			this.terminalRibbonIcon.remove();
			this.terminalRibbonIcon = null;
		}
	}

	/**
	 * Get the next available terminal ID (finds lowest unused number starting from 1)
	 */
	private getNextTerminalId(): number {
		let id = 1;
		while (this.usedTerminalIds.has(id)) {
			id++;
		}
		this.usedTerminalIds.add(id);
		return id;
	}

	/**
	 * Release a terminal ID when a terminal is closed
	 */
	public releaseTerminalId(id: number): void {
		this.usedTerminalIds.delete(id);
	}

	private async initializeTerminalFeatures(): Promise<void> {
		try {
			// Dynamic import to avoid loading terminal code when not needed
			const { ClaudeTerminalView, TERMINAL_VIEW_TYPE } = await import(
				"./src/terminal/terminal-view"
			);

			// Register terminal view
			this.registerView(
				TERMINAL_VIEW_TYPE,
				(leaf) => new ClaudeTerminalView(leaf, this)
			);

			// Add ribbon button for terminal toggle
			this.addTerminalRibbonIcon();

			// Register commands - no hardcoded hotkeys, let users configure
			this.addCommand({
				id: "toggle-claude-terminal",
				name: "Toggle Claude Terminal",
				callback: () => this.toggleClaudeTerminal(),
			});

			this.addCommand({
				id: "new-claude-terminal",
				name: "New Claude Terminal",
				callback: () => this.newClaudeTerminal(),
			});

			this.addCommand({
				id: "close-all-claude-terminals",
				name: "Close All Claude Terminals",
				callback: () => this.closeAllTerminals(),
			});

			// Track terminal focus changes for MRU (most recently used)
			this.registerEvent(
				this.app.workspace.on("active-leaf-change", async (leaf) => {
					if (leaf) {
						const { TERMINAL_VIEW_TYPE: termType } = await import(
							"./src/terminal/terminal-view"
						);
						const terminals = this.app.workspace.getLeavesOfType(termType);
						if (terminals.includes(leaf)) {
							this.lastFocusedTerminalLeaf = leaf;
						}
					}
				})
			);
		} catch (error) {
			console.error(
				"[Terminal] Failed to initialize terminal features:",
				error
			);
			new Notice("Failed to initialize terminal features");
		}
	}

	private async toggleClaudeTerminal(): Promise<void> {
		try {
			// Check if terminal is enabled
			if (!this.settings.enableEmbeddedTerminal) {
				new Notice(
					"Embedded terminal is disabled. Enable it in settings to use this feature."
				);
				return;
			}

			// Dynamic import to get terminal constants
			const { TERMINAL_VIEW_TYPE } = await import(
				"./src/terminal/terminal-view"
			);

			const terminals = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);

			if (terminals.length === 0) {
				// No terminals exist - create one
				await this.newClaudeTerminal();
				return;
			}

			const activeLeaf = this.app.workspace.activeLeaf;
			const activeIsTerminal = terminals.some((t) => t === activeLeaf);

			if (activeIsTerminal && activeLeaf) {
				// Active leaf is a terminal - close it
				const view = activeLeaf.view as any;
				if (view?.instanceId) {
					this.releaseTerminalId(view.instanceId);
				}
				activeLeaf.detach();

				// Update last focused to another terminal if one exists
				const remaining = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
				this.lastFocusedTerminalLeaf =
					remaining.length > 0 ? remaining[remaining.length - 1] : null;
			} else {
				// Focus the most recently used terminal, or last in list
				const targetLeaf =
					this.lastFocusedTerminalLeaf &&
					terminals.includes(this.lastFocusedTerminalLeaf)
						? this.lastFocusedTerminalLeaf
						: terminals[terminals.length - 1];

				this.app.workspace.revealLeaf(targetLeaf);
				this.lastFocusedTerminalLeaf = targetLeaf;

				setTimeout(() => {
					const view = targetLeaf.view as any;
					if (view?.focusTerminal) {
						view.focusTerminal();
					}
				}, 50);
			}
		} catch (error) {
			console.error("[Terminal] Failed to toggle terminal:", error);
			new Notice("Failed to toggle Claude Terminal");
		}
	}

	/**
	 * Create a new terminal instance
	 */
	private async newClaudeTerminal(): Promise<void> {
		try {
			// Check if terminal is enabled
			if (!this.settings.enableEmbeddedTerminal) {
				new Notice(
					"Embedded terminal is disabled. Enable it in settings to use this feature."
				);
				return;
			}

			const { TERMINAL_VIEW_TYPE } = await import(
				"./src/terminal/terminal-view"
			);

			// Check resource limit
			const existingCount =
				this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE).length;
			if (existingCount >= ClaudeMcpPlugin.MAX_TERMINALS) {
				new Notice(
					`Maximum of ${ClaudeMcpPlugin.MAX_TERMINALS} terminals reached`
				);
				return;
			}

			const leaf = this.app.workspace.getLeaf("split");
			const instanceId = this.getNextTerminalId();

			await leaf.setViewState({
				type: TERMINAL_VIEW_TYPE,
				state: { instanceId },
			});
			this.app.workspace.revealLeaf(leaf);

			// Track as last focused
			this.lastFocusedTerminalLeaf = leaf;

			// Focus terminal after delay
			setTimeout(() => {
				const view = leaf.view as any;
				if (view?.focusTerminal) {
					view.focusTerminal();
				}
			}, 150);
		} catch (error) {
			console.error("[Terminal] Failed to create new terminal:", error);
			new Notice("Failed to create new Claude Terminal");
		}
	}

	/**
	 * Close all open terminal instances
	 */
	private async closeAllTerminals(): Promise<void> {
		try {
			const { TERMINAL_VIEW_TYPE } = await import(
				"./src/terminal/terminal-view"
			);

			const leaves = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);

			// Close sequentially to avoid race conditions
			for (const leaf of leaves) {
				const view = leaf.view as any;
				if (view?.instanceId) {
					this.releaseTerminalId(view.instanceId);
				}
				leaf.detach();
			}

			this.lastFocusedTerminalLeaf = null;

			if (leaves.length > 0) {
				new Notice(`Closed ${leaves.length} terminal(s)`);
			}
		} catch (error) {
			console.error("[Terminal] Failed to close all terminals:", error);
			new Notice("Failed to close terminals");
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
