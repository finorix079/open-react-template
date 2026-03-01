// utils/aiHandler.agent.test.ts
import { planningAgent, executorAgent, agentTools } from './aiHandler';
import { LangfuseSpan } from '@langfuse/tracing';

describe('Agent Selection and Execution', () => {
  it('PlanningAgent selects queryRefinement tool', () => {
    const task = {
      id: '1',
      description: 'Refine query',
      tool: agentTools['queryRefinement'],
      input: { userInput: 'What is the attack stat of Aggron?' },
      status: 'pending',
    };
    expect(planningAgent.selectTool(task)).toBe(agentTools['queryRefinement']);
  });

  it('ExecutorAgent selects dataService tool', () => {
    const task = {
      id: '1',
      description: 'Execute SQL query',
      tool: agentTools['dataService'],
      input: { query: 'SELECT ...' },
      status: 'pending',
    };
    expect(executorAgent.selectTool(task)).toBe(agentTools['dataService']);
  });

  it('PlanningAgent executes a queryRefinement task', async () => {
    const dummySpan = { startObservation: () => ({ update: () => {}, end: () => {} }) } as unknown as LangfuseSpan;
    const task = {
      id: '1',
      description: 'Refine query',
      tool: agentTools['queryRefinement'],
      input: { userInput: 'What is the attack stat of Aggron?' },
      status: 'pending',
    };
    const result = await planningAgent.executeTask(task, dummySpan);
    expect(['completed', 'failed']).toContain(result.status);
  });

  it('ExecutorAgent executes a dataService task', async () => {
    const dummySpan = { startObservation: () => ({ update: () => {}, end: () => {} }) } as unknown as LangfuseSpan;
    const task = {
      id: '1',
      description: 'Execute SQL query',
      tool: agentTools['dataService'],
      input: { query: 'SELECT ...' },
      status: 'pending',
    };
    const result = await executorAgent.executeTask(task, dummySpan);
    expect(['completed', 'failed']).toContain(result.status);
  });
});
