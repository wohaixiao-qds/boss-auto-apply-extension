import type { AgentToolDefinition } from "../types";

interface RegisteredTool extends AgentToolDefinition {
  execute: (input?: unknown) => Promise<unknown> | unknown;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<T>(definition: AgentToolDefinition, execute: (input?: unknown) => Promise<T> | T): void {
    this.tools.set(definition.name, { ...definition, execute });
  }

  async execute<T>(name: string, input?: unknown): Promise<T> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知 Agent 工具：${name}`);
    return await tool.execute(input) as T;
  }

  list(): AgentToolDefinition[] {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }
}
