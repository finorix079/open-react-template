'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../app/css/additional-styles/chat-widget.css';
import Logo from './ui/logo';

interface PlanStep {
  step_number?: number;
  description?: string;
  api?: string;
  parameters?: Record<string, any>;
  requestBody?: Record<string, any>;
  depends_on_step?: number;
}

interface PlanSummary {
  goal?: string;
  phase?: string;
  steps?: PlanStep[];
  selected_apis?: any[];
}

interface Message {
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

type TaskPayload = {
  taskName: string;
  taskType: number;
  taskContent: string;
  taskSteps: Array<{
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
  }>;
  originalQuery?: string;
  planResponse?: string;
};

export default function ChatWidget2() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Tracks whether we're currently waiting for plan approval.
  // A ref (not state) so the stream-reading closure always sees the current value.
  const isAwaitingApprovalRef = useRef(false);

  // // Load chat history from localStorage on mount
  // useEffect(() => {
  //   try {
  //     const savedMessages = localStorage.getItem('chatWidget2_messages');
  //     if (savedMessages) {
  //       const parsed = (JSON.parse(savedMessages)).map((msg: any) => ({
  //         ...msg,
  //         content: typeof msg.content === 'string'
  //           ? msg.content.replace(/```[a-zA-Z]*/g, '\n```')
  //           : msg.content
  //       }));
  //       console.log('savedMessages:', savedMessages);
  //       setMessages(parsed);
  //     }
  //   } catch (error) {
  //     console.warn('Failed to load chat history:', error);
  //   }
  // }, []);

  // // Save chat history to localStorage whenever messages change
  // useEffect(() => {
  //   try {
  //     if (messages.length > 0) {
  //       localStorage.setItem('chatWidget2_messages', JSON.stringify(messages));
  //     }
  //   } catch (error) {
  //     console.warn('Failed to save chat history:', error);
  //   }
  // }, [messages]);

  const sanitizeContent = (text: string) => text.replace(/```/g, '').trim();

  const cleanCodeBlockLanguage = (text: string) => {
    return text.replace(/: ```[a-zA-Z]+/g, ': \n\n```');
  };

  const cleanMessagesCodeBlocks = (msgs: Message[]) => {
    return msgs.map((msg) => ({
      ...msg,
      content: typeof msg.content === 'string' ? cleanCodeBlockLanguage(msg.content) : msg.content,
    }));
  };

  const isReadOperation = (apiText: string) => {
    const lowered = apiText.toLowerCase();
    return lowered.includes('/general/sql/query') || lowered.startsWith('get');
  };

  const inferTaskTypeFromSteps = (steps: PlanStep[] = []) => {
    const hasWrite = steps.some((step) => {
      const apiText = step.api?.toLowerCase() || '';
      if (isReadOperation(apiText)) return false;
      return apiText.startsWith('post') || apiText.startsWith('put') || apiText.startsWith('patch') || apiText.startsWith('delete');
    });
    return hasWrite ? 2 : 1;
  };

  const extractMethod = (api?: string) => {
    if (!api) return '';
    const first = api.trim().split(' ')[0];
    return first.toUpperCase();
  };

  const stepTypeFromApi = (api?: string) => {
    const method = extractMethod(api);
    const normalized = api?.toLowerCase() || '';
    if (isReadOperation(normalized)) return 1;
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 2 : 1;
  };

  const extractTaskTemplateName = (refinedQuery: string, goal: string): string => {
    const text = (refinedQuery || goal || '').trim();
    let cleaned = text.replace(/\b(my|a|an|the)\s+/gi, '');
    cleaned = cleaned.replace(/'[^']+'/g, '');
    cleaned = cleaned.replace(/"[^"]+"/g, '');
    cleaned = cleaned.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g, (match) => {
      return /^(add|remove|clear|delete|update|get|create|list)$/i.test(match) ? match : '';
    });
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned.length > 3 ? cleaned : text.slice(0, 50).trim();
  };

  const detectEntityFromQuery = (refinedQuery: string) => {
    const text = refinedQuery || '';
    const quoted = text.match(/['"]([^'"]+)['"]/);
    if (quoted) return quoted[1];
    const verbNoun = text.match(/\b(?:add|remove|delete|drop|clear)\s+([A-Za-z0-9_-]+)/i);
    if (verbNoun) return verbNoun[1];
    const lastToken = text.trim().split(/\s+/).pop();
    return lastToken && lastToken.length > 1 ? lastToken : undefined;
  };

  const parameterizeApiDetails = (step: PlanStep, refinedQuery: string): any => {
    if (!step.api) return undefined;

    const apiStr = step.api.trim();
    const parts = apiStr.split(' ');
    if (parts.length < 2) return undefined;

    const method = parts[0].toUpperCase();
    let path = parts.slice(1).join(' ');
    const parameters = step.parameters ? { ...step.parameters } : {};
    const requestBody = step.requestBody ? JSON.parse(JSON.stringify(step.requestBody)) : {};

    const primaryEntity = detectEntityFromQuery(refinedQuery);
    const namePlaceholder = path.includes('team') ? '{TEAM_NAME}' : '{POKEMON_NAME}';

    path = path.replace(/\/pokemon\/\d+/gi, '/pokemon/{POKEMON_ID}');
    path = path.replace(/\/teams\/\d+/gi, '/teams/{TEAM_ID}');
    path = path.replace(/\/\d+\b/g, '/{ID}');

    if (primaryEntity) {
      path = path.replace(new RegExp(primaryEntity, 'gi'), namePlaceholder);
    }

    Object.keys(parameters || {}).forEach((key) => {
      if (typeof parameters[key] === 'string' && primaryEntity && parameters[key].toLowerCase() === primaryEntity.toLowerCase()) {
        parameters[key] = namePlaceholder;
      }
      if (typeof parameters[key] === 'number') {
        parameters[key] = key.toLowerCase().includes('pokemon') ? '{POKEMON_ID}' : '{ID}';
      }
    });

    if (primaryEntity) {
      parameterizeValue(requestBody, primaryEntity, namePlaceholder);
    }
    parameterizeNumericIds(requestBody);

    if (requestBody.query && typeof requestBody.query === 'string') {
      if (primaryEntity) {
        requestBody.query = requestBody.query.replace(new RegExp(primaryEntity, 'gi'), namePlaceholder);
      }
      requestBody.query = requestBody.query.replace(/=\s*\d+/g, (m: string) => m.replace(/\d+/, '{ID}'));
      requestBody.query = requestBody.query.replace(/IN\s*\([^)]+\)/gi, 'IN ({ID_LIST})');
    }

    return {
      path,
      method: method.toLowerCase(),
      parameters,
      requestBody,
    };
  };

  const parameterizeValue = (obj: any, searchValue: string, placeholder: string) => {
    if (typeof obj !== 'object' || obj === null) return;

    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key].replace(new RegExp(searchValue, 'gi'), placeholder);
      } else if (typeof obj[key] === 'object') {
        parameterizeValue(obj[key], searchValue, placeholder);
      }
    }
  };

  const parameterizeNumericIds = (obj: any) => {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key in obj) {
      if (typeof obj[key] === 'number') {
        obj[key] = key.toLowerCase().includes('pokemon') ? '{POKEMON_ID}' : '{ID}';
      } else if (typeof obj[key] === 'string' && /\b\d+\b/.test(obj[key])) {
        obj[key] = obj[key].replace(/\b\d+\b/g, '{ID}');
      } else if (typeof obj[key] === 'object') {
        parameterizeNumericIds(obj[key]);
      }
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    console.log('Messages updated:', messages);
    scrollToBottom();
  }, [messages]);

  /**
   * Reads a streaming response in the Vercel AI SDK data-stream wire protocol
   * and dispatches each frame to update component state.
   *
   * Wire format (each line: `<prefix>:<json>\n`):
   *   f: — message start (ignored)
   *   0: — text delta  (string)
   *   2: — data array  [{type:'status'|'plan'|'result'|'tool_call', ...}]
   *   3: — error       (string)
   *   e: — finish step (ignored)
   *   d: — done / close stream
   */
  const consumeAIDataStream = async (response: Response) => {
    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasStreamingPlaceholder = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        const prefix = trimmed.slice(0, colonIdx);
        const jsonStr = trimmed.slice(colonIdx + 1);

        let parsed: unknown;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }

        switch (prefix) {
          case '0': {
            // Text delta — append to the last streaming assistant message
            const token = typeof parsed === 'string' ? parsed : '';
            if (!hasStreamingPlaceholder) {
              hasStreamingPlaceholder = true;
              setIsLoading(false);
              setStreamingStatus(null);
              setMessages((prev) => [...prev, { role: 'assistant', content: token }]);
            } else {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + token };
                }
                return updated;
              });
            }
            break;
          }

          case '2': {
            // Data event — array of typed payloads
            const items = Array.isArray(parsed) ? parsed : [];
            for (const item of items as Array<Record<string, unknown>>) {
              const type = item.type as string;

              if (type === 'status') {
                setStreamingStatus((item.message as string) ?? '');
                // Don't re-enable loading spinner while waiting for user approval —
                // that would disable the Approve/Reject buttons.
                if (!isAwaitingApprovalRef.current) {
                  setIsLoading(true);
                }
              } else if (type === 'plan') {
                isAwaitingApprovalRef.current = true;
                setIsLoading(false);
                setStreamingStatus(null);
                setMessages((prev) =>
                  cleanMessagesCodeBlocks([
                    ...prev,
                    {
                      role: 'assistant',
                      content: (item.message as string) ?? 'Here is my plan:',
                      awaitingApproval: item.awaitingApproval as boolean,
                      sessionId: item.sessionId as string,
                      planResponse: item.planResponse as string,
                      refinedQuery: item.refinedQuery as string,
                    },
                  ]),
                );
              } else if (type === 'result') {
                setIsLoading(false);
                setStreamingStatus(null);
                setMessages((prev) =>
                  cleanMessagesCodeBlocks([
                    ...prev,
                    {
                      role: 'assistant',
                      content:
                        (item.message as string) ??
                        'I apologize, but I was unable to process your request.',
                      awaitingApproval: item.awaitingApproval as boolean | undefined,
                      sessionId: item.sessionId as string | undefined,
                      planResponse: item.planResponse as string | undefined,
                      refinedQuery: item.refinedQuery as string | undefined,
                    },
                  ]),
                );
              }
            }
            break;
          }

          case '3': {
            // Error
            setIsLoading(false);
            setStreamingStatus(null);
            const errMsg = typeof parsed === 'string' ? parsed : 'An error occurred.';
            setMessages((prev) =>
              cleanMessagesCodeBlocks([...prev, { role: 'assistant', content: errMsg }]),
            );
            break;
          }

          case 'd': {
            // Done — apply final cleanup
            setMessages((prev) => cleanMessagesCodeBlocks(prev));
            break;
          }

          default:
            break;
        }
      }
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input.trim() };
    const updatedMessages = cleanMessagesCodeBlocks([...messages, userMessage]);
    setMessages(updatedMessages);
    setInput('');
    setIsLoading(true);
    setStreamingStatus(null);

    try {
      const trivialResponses: { [key: string]: string } = {
        hello: 'Hi there! How can I assist you today?',
        hi: 'Hello! How can I help you?',
        thanks: 'You are welcome!',
        bye: 'Goodbye! Have a great day!',
      };

      const lowerCaseInput = input.trim().toLowerCase();
      if (trivialResponses[lowerCaseInput]) {
        setMessages((prev) => [...prev, { role: 'assistant', content: trivialResponses[lowerCaseInput] }]);
        setIsLoading(false);
        return;
      }

      const response = await fetch('/api/chat-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.getItem('token')
            ? `Bearer ${localStorage.getItem('token')}`
            : '',
        },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      // consumeAIDataStream reads until the server closes the stream,
      // which may be after the user approves a plan via /api/approve.
      await consumeAIDataStream(response);
    } catch (error: unknown) {
      setMessages((prev) =>
        cleanMessagesCodeBlocks([
          ...prev,
          { role: 'assistant', content: 'An error occurred while processing your request. Please try again.' },
        ]),
      );
      console.warn('Error in sendMessage:', error);
    } finally {
      setIsLoading(false);
      setStreamingStatus(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  /**
   * Signals the user's approval or rejection to POST /api/approve.
   * The original SSE stream from sendMessage is still open and polling
   * for this signal — it will receive the execution updates automatically.
   */
  const handleApproval = async (approved: boolean, sessionId?: string) => {
    if (!sessionId) return;

    isAwaitingApprovalRef.current = false;
    // Show loading while the approval is being processed; the original
    // consumeAIDataStream call will re-manage loading state once execution begins.
    setIsLoading(true);
    setStreamingStatus(null);

    const label = approved ? 'approve' : 'reject';
    setMessages((prev) =>
      cleanMessagesCodeBlocks([...prev, { role: 'user', content: label }]),
    );

    try {
      const response = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, approved }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error((err as { error?: string }).error ?? 'Failed to submit decision');
      }
      // Success — the original stream will now emit execution events.
      // Do NOT set isLoading=false here; consumeAIDataStream owns loading state from here.
    } catch (error: unknown) {
      setMessages((prev) =>
        cleanMessagesCodeBlocks([
          ...prev,
          { role: 'assistant', content: 'An error occurred while processing your decision. Please try again.' },
        ]),
      );
      setIsLoading(false);
      setStreamingStatus(null);
      console.warn('Error in handleApproval:', error);
    }
  };

  const toggleWidget = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <>
      <div className="chat-widget-container">
        <div className={`chat-panel ${isExpanded ? 'expanded' : 'collapsed'}`}>
          <div className="chat-header">
            <div className="chat-header-content">
              <div className="chat-avatar">
                <Logo className="h-6" />
              </div>
              <div className="chat-header-text">
                <h3>New Chat</h3>
              </div>
            </div>
            <button className="close-button" onClick={toggleWidget} aria-label="Close chat">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M15 5L5 15M5 5L15 15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-center text-gray-400">
                  Hello! I am your AI assistant. How can I help you today?
                </p>
              </div>
            )}
            {messages.map((msg, index) => (
              <div key={index} className={`message ${msg.role === 'user' ? 'user' : 'assistant'}`}>
                <div className="message-content-wrapper">
                  <div className="message-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}
                    </ReactMarkdown>

                    {/* Planning metrics */}
                    {msg.role === 'assistant' && (msg.planningDurationMs !== undefined || msg.usedReferencePlan) && (
                        <div className="mt-2 text-xs text-gray-400 border-t border-gray-700 pt-2">
                        {msg.usedReferencePlan && <div>🪄 Used reference plan</div>}
                        {msg.planningDurationMs !== undefined && <div>⏱️ Planning: {msg.planningDurationMs}ms</div>}
                        </div>
                    )}

                    {/* Save Task button */}
                    {/* {msg.role === 'assistant' && msg.planSummary && msg.planSummary.steps && msg.planSummary.steps.length > 0 && (
                        <div className="mt-3 flex flex-col gap-2">
                        <button
                            onClick={() => handleSaveTask(msg)}
                            disabled={isSavingTask}
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-700 disabled:opacity-50"
                        >
                            Save this task
                        </button>
                        </div>
                    )} */}

                    {/* Approve/Reject buttons */}
                    {msg.awaitingApproval && index === messages.length - 1 && (
                        <div className="mt-3 flex gap-2">
                        <button
                            onClick={() => handleApproval(true, msg.sessionId)}
                            disabled={isLoading}
                            className="flex-1 rounded-lg bg-green-100 px-4 py-2 text-sm font-medium text-green-700 transition-all hover:bg-green-200 disabled:opacity-50"
                        >
                            ✓ Approve
                        </button>
                        <button
                            onClick={() => handleApproval(false, msg.sessionId)}
                            disabled={isLoading}
                            className="flex-1 rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-700 transition-all hover:bg-red-200 disabled:opacity-50"
                        >
                            ✗ Reject
                        </button>
                        </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* Loading animation / status */}
            {isLoading && (
              <div className="message assistant">
                <div className="message-content-wrapper">
                  {streamingStatus ? (
                    <div className="text-sm italic text-gray-400">{streamingStatus}</div>
                  ) : (
                  <div className="flex space-x-2">
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '0ms' }}></div>
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '150ms' }}></div>
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '300ms' }}></div>
                  </div>
                  )}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-container">
            <form className="chat-input-form" onSubmit={(e) => { e.preventDefault(); sendMessage(); }}>
              <input
                type="text"
                className="chat-input"
                placeholder={messages.length > 0 ? 'Continue your conversation...' : 'Ask me anything...'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
              />
              <button
                type="submit"
                className="send-button"
                disabled={!input.trim() || isLoading}
                aria-label="Send message"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M18 2L9 11M18 2L12 18L9 11M18 2L2 8L9 11"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </form>
          </div>
        </div>

        <button
          className={`chat-toggle-button font-semibold ${isExpanded ? 'expanded' : ''}`}
          onClick={toggleWidget}
          aria-label="Toggle chat"
        >
            <Logo className="h-6" />
            AI Assistant
        </button>
      </div>
    </>
  );
}
