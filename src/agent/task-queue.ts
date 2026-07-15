import type { AgentStep, AgentTask } from "../types";

const taskId = (step: AgentStep): string => `task-${step}-${crypto.randomUUID()}`;

export class AgentTaskQueue {
  private tasks: AgentTask[];

  constructor(tasks?: AgentTask[]) {
    this.tasks = tasks?.length ? tasks : [];
  }

  activate(step: AgentStep): AgentTask | null {
    const task = this.tasks.find(item => item.step === step) || (() => {
      const created: AgentTask = { id: taskId(step), step, status: "pending", attempts: 0, maxAttempts: 3, error: "" };
      this.tasks.push(created);
      return created;
    })();
    task.status = "running";
    task.attempts += 1;
    return task;
  }

  complete(step: AgentStep): void {
    const task = this.tasks.find(item => item.step === step);
    if (task) task.status = "completed";
  }

  fail(step: AgentStep, error: string): void {
    const task = this.tasks.find(item => item.step === step);
    if (task) { task.status = "failed"; task.error = error; }
  }

  canRetry(step: AgentStep): boolean {
    const task = this.tasks.find(item => item.step === step);
    return Boolean(task && task.attempts < task.maxAttempts);
  }

  snapshot(): AgentTask[] {
    return this.tasks.map(task => ({ ...task }));
  }
}
