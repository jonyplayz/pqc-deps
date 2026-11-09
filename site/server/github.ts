/** Minimal GitHub REST client for the Functions (fetch only, no SDK). */
import { HttpError } from './http';
import type { Env } from './env';

export class GitHub {
  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(env: Env, fetchImpl?: typeof fetch): GitHub {
    if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
      throw new HttpError(503, 'The server is not configured to talk to GitHub yet.');
    }
    return new GitHub(env.GITHUB_REPO, env.GITHUB_TOKEN, fetchImpl);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path.replace('{repo}', this.repo)}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pqc-deps-site',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
      throw new HttpError(502, `GitHub returned ${res.status}.`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  dispatch(workflow: string, inputs: Record<string, string>): Promise<void> {
    return this.request('POST', `/repos/{repo}/actions/workflows/${workflow}/dispatches`, {
      ref: 'main',
      inputs,
    });
  }

  async runs(workflow: string, perPage = 10): Promise<WorkflowRun[]> {
    const r = await this.request<{ workflow_runs: WorkflowRun[] }>(
      'GET',
      `/repos/{repo}/actions/workflows/${workflow}/runs?per_page=${perPage}`,
    );
    return r.workflow_runs;
  }

  pulls(): Promise<PullRequest[]> {
    return this.request('GET', '/repos/{repo}/pulls?state=open&per_page=50');
  }

  issues(labels: string): Promise<Issue[]> {
    return this.request(
      'GET',
      `/repos/{repo}/issues?state=open&labels=${encodeURIComponent(labels)}&per_page=50`,
    );
  }

  issue(number: number): Promise<Issue> {
    return this.request('GET', `/repos/{repo}/issues/${number}`);
  }

  createIssue(title: string, body: string, labels: string[]): Promise<Issue> {
    return this.request('POST', '/repos/{repo}/issues', { title, body, labels });
  }

  comment(number: number, body: string): Promise<void> {
    return this.request('POST', `/repos/{repo}/issues/${number}/comments`, { body });
  }

  addLabels(number: number, labels: string[]): Promise<void> {
    return this.request('POST', `/repos/{repo}/issues/${number}/labels`, { labels });
  }

  close(number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    return this.request('PATCH', `/repos/{repo}/issues/${number}`, {
      state: 'closed',
      state_reason: reason,
    });
  }

  /** Issues with `label` created in the last 24 hours (open or closed). */
  async countRecent(label: string, now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 19) + 'Z';
    const q = `repo:${this.repo} is:issue label:"${label}" created:>=${since}`;
    const r = await this.request<{ total_count: number }>(
      'GET',
      `/search/issues?q=${encodeURIComponent(q)}&per_page=1`,
    );
    return r.total_count;
  }
}

export interface WorkflowRun {
  id: number;
  name: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  event: string;
}
export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  head: { ref: string };
}
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export const labelNames = (i: Issue) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));
