/**
 * src/agent/planner.ts
 * TaskPlanner: decompose user requests into executable steps.
 */
import type { UnifiedMessage } from '../types/message.js';
import type { MCPToolRegistry } from '../mcp/registry.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ module: 'agent:planner' });

export interface TaskStep {
  id: string;
  description: string;
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  dependsOn?: string[] | undefined;
}

export interface TaskPlan {
  taskId: string;
  description: string;
  steps: TaskStep[];
  requiresHumanInput: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

/**
 * Heuristic-based task planner.
 * For simple tasks, returns a single-step plan.
 * For complex tasks, decomposes into ordered steps.
 */
export class TaskPlanner {
  private readonly registry: MCPToolRegistry;

  constructor(registry: MCPToolRegistry) {
    this.registry = registry;
  }

  /**
   * Analyze a user message and create a task plan.
   * This is a heuristic planner — the LLM will handle actual tool selection.
   */
  createPlan(message: UnifiedMessage, taskId: string): TaskPlan {
    const text = message.text.toLowerCase();

    // Detect task complexity based on keywords
    const requiresBrowser = this.requiresBrowserInteraction(text);
    const requiresAuth = this.requiresAuthentication(text);
    const isMultiStep = requiresBrowser && requiresAuth;

    const steps: TaskStep[] = [];
    let stepCounter = 0;

    // If authentication is needed, plan it as a prerequisite
    if (requiresAuth) {
      steps.push({
        id: `step-${++stepCounter}`,
        description: 'Authenticate to the target service',
        toolName: 'login_account',
      });
    }

    // Main task step
    if (this.isFormFilling(text)) {
      steps.push({
        id: `step-${++stepCounter}`,
        description: 'Fill and submit the form',
        toolName: 'fill_form',
        dependsOn: requiresAuth ? ['step-1'] : undefined,
      });
    } else if (this.isAppointmentBooking(text)) {
      steps.push({
        id: `step-${++stepCounter}`,
        description: 'Book the appointment',
        toolName: 'book_appointment',
        dependsOn: requiresAuth ? ['step-1'] : undefined,
      });
    } else if (this.isWebScraping(text)) {
      steps.push({
        id: `step-${++stepCounter}`,
        description: 'Scrape the website for information',
        toolName: 'scrape_website',
      });
    } else {
      // Generic conversational step — handled by LLM
      steps.push({
        id: `step-${++stepCounter}`,
        description: 'Process the user request',
      });
    }

    const complexity: TaskPlan['estimatedComplexity'] = isMultiStep
      ? 'high'
      : requiresBrowser
      ? 'medium'
      : 'low';

    log.debug({
      taskId,
      steps: steps.length,
      complexity,
      requiresBrowser,
    }, 'Task plan created');

    return {
      taskId,
      description: message.text.slice(0, 100),
      steps,
      requiresHumanInput: false,
      estimatedComplexity: complexity,
    };
  }

  private requiresBrowserInteraction(text: string): boolean {
    const keywords = ['fill', 'form', 'book', 'appointment', 'register', 'login', 'sign', 'submit', 'website', 'page', 'url', 'http'];
    return keywords.some((k) => text.includes(k));
  }

  private requiresAuthentication(text: string): boolean {
    const keywords = ['login', 'log in', 'sign in', 'authenticate', 'logged in', 'account'];
    return keywords.some((k) => text.includes(k));
  }

  private isFormFilling(text: string): boolean {
    return text.includes('fill') || text.includes('form') || text.includes('submit');
  }

  private isAppointmentBooking(text: string): boolean {
    return text.includes('book') || text.includes('appointment') || text.includes('schedule') || text.includes('reservation');
  }

  private isWebScraping(text: string): boolean {
    return text.includes('scrape') || text.includes('extract') || text.includes('find') || text.includes('get') || text.includes('read');
  }
}
