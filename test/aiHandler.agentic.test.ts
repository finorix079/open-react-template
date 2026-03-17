import { describe, it, expect } from 'vitest';
import { runAgenticFlow, AgentPlan, AgentTool, AgentTask } from '../utils/aiHandler';

const mockTool: AgentTool = {
  name: 'mockTool',
  async execute(input) {
    return `processed: ${input}`;
  },
};

describe('runAgenticFlow', () => {
  it('should process all tasks and mark them completed', async () => {
    const plan: AgentPlan = {
      goal: 'Test agentic flow',
      tasks: [
        { id: '1', description: 'Test', tool: mockTool, input: 'foo', status: 'pending' },
      ],
    };
    const result = await runAgenticFlow(plan);
    expect(result.tasks[0].status).toBe('completed');
    expect(result.tasks[0].output).toBe('processed: foo');
  });

  it('should mark task as failed if tool throws', async () => {
    const errorTool: AgentTool = {
      name: 'errorTool',
      async execute() { throw new Error('fail'); },
    };
    const plan: AgentPlan = {
      goal: 'Test error',
      tasks: [
        { id: '2', description: 'Error', tool: errorTool, input: 'bar', status: 'pending' },
      ],
    };
    const result = await runAgenticFlow(plan);
    expect(result.tasks[0].status).toBe('failed');
    expect(result.tasks[0].output).toBeInstanceOf(Error);
  });
});
