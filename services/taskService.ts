export interface TaskStep {
  stepOrder: number;
  stepType: number;
  stepContent: string;
  stepJsonContent?: Object;
  api?: {
    path: string;
    method: string;
    parameters?: Record<string, any>;
    requestBody?: Record<string, any>;
  };
  depends_on_step?: number;
}

export interface TaskPayload {
  taskName: string;
  taskType: number;
  taskContent: string;
  taskSteps: TaskStep[];
  originalQuery?: string;
  planResponse?: string;
}

export interface SavedTask extends TaskPayload {
  id: number;
  taskName: string;
  taskType: number;
  taskContent: string;
  createdAt: string;
  steps?: TaskStep[];
}

export interface PlanStep {
  step_number?: number;
  description?: string;
  api?: string;
  parameters?: Record<string, any>;
  requestBody?: Record<string, any>;
  depends_on_step?: number;
}

export interface PlanSummary {
  goal?: string;
  phase?: string;
  steps?: PlanStep[];
  selected_apis?: any[];
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  awaitingApproval?: boolean;
  sessionId?: string;
  planSummary?: PlanSummary;
  planResponse?: string;
  refinedQuery?: string;
  planningDurationMs?: number;
  usedReferencePlan?: boolean;
}

