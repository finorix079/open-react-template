# Dual-Agent Agentic Flow Documentation

## Overview
This project uses a dual-agent architecture for agentic orchestration:
- **plannerAgent**: Responsible for generating and refining execution plans.
- **ExecutorAgent**: Responsible for executing plan steps using available tools.

Both agents share a common tool set but have distinct responsibilities and traces.

## Flow
1. **Planning Phase**
   - plannerAgent receives the user query and context.
   - plannerAgent generates an execution plan (traced separately).
2. **Execution Phase**
   - ExecutorAgent receives the actionable plan from plannerAgent.
   - ExecutorAgent executes each step using the appropriate tool (traced separately).

## Benefits
- Clear separation of concerns for planning and execution.
- Improved trace clarity and error diagnosis.
- Easier extensibility for future agentic phases.

## Key Files
- `utils/aiHandler.ts`: Defines plannerAgent and ExecutorAgent.
- `app/api/chat/route.ts`: Orchestrates planning and execution phases.
- `app/api/chat/plannerUtils.ts`: Ensures planner output is compatible with agent handoff.

## Example Trace
- plannerAgent trace: Plan generation, query refinement, context analysis.
- ExecutorAgent trace: Step execution, tool invocation, result aggregation.

## Error Handling
- Errors in planning or execution are surfaced in their respective traces.
- Plan handoff is explicit; failures in either phase are logged and returned to the user.

---
Step 7 completed.
