import https from 'https';

export type PriorityLevel = 'high' | 'medium' | 'low';

export interface IssuePriority {
  number: number;
  priority: PriorityLevel;
  score: number;
  reason: string;
}

interface IssueInput {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  comments: number;
  created_at: string;
  state: string;
}

const CRITICAL_PATTERNS = ['critical', 'blocker', 'security', 'vulnerability', 'crash', 'data-loss', 'data loss'];
const HIGH_PATTERNS = ['bug', 'high', 'p0', 'p1', 'urgent', 'priority:high', 'high-priority'];
const LOW_PATTERNS = ['nice-to-have', 'enhancement', 'feature', 'improvement', 'low', 'p3', 'wontfix', 'documentation', 'docs'];

function heuristicScore(issue: IssueInput): number {
  let score = 0;
  const labels = issue.labels.map(l => l.name.toLowerCase());

  if (labels.some(l => CRITICAL_PATTERNS.some(p => l.includes(p)))) {
    score += 30;
  } else if (labels.some(l => HIGH_PATTERNS.some(p => l === p || l.includes(p)))) {
    score += 15;
  } else if (labels.some(l => LOW_PATTERNS.some(p => l.includes(p)))) {
    score -= 10;
  }

  // Engagement bonus
  score += Math.min(issue.comments * 2, 15);

  // Age bonus (older open issues deserve attention)
  const ageDays = (Date.now() - Date.parse(issue.created_at)) / 86_400_000;
  score += Math.min(ageDays / 14, 10);

  return score;
}

function levelFromScore(score: number): PriorityLevel {
  if (score >= 25) return 'high';
  if (score >= 10) return 'medium';
  return 'low';
}

function reasonFromScore(issue: IssueInput, score: number): string {
  const labels = issue.labels.map(l => l.name.toLowerCase());
  if (labels.some(l => CRITICAL_PATTERNS.some(p => l.includes(p)))) return 'Critical/security label detected';
  if (labels.some(l => HIGH_PATTERNS.some(p => l.includes(p)))) return 'High-priority label detected';
  if (issue.comments > 5) return `High engagement (${issue.comments} comments)`;
  const ageDays = Math.round((Date.now() - Date.parse(issue.created_at)) / 86_400_000);
  if (ageDays > 30) return `Open for ${ageDays} days`;
  if (score < 5) return 'Low-priority label or enhancement';
  return 'Assessed by activity and labels';
}

export function heuristicPrioritize(issues: IssueInput[]): { priorities: IssuePriority[]; usingAI: boolean } {
  const priorities = issues
    .filter(i => i.state !== 'closed')
    .map(issue => {
      const score = heuristicScore(issue);
      return {
        number: issue.number,
        priority: levelFromScore(score),
        score,
        reason: reasonFromScore(issue, score),
      };
    });
  return { priorities, usingAI: false };
}

async function callAnthropic(issues: IssueInput[], apiKey: string): Promise<IssuePriority[]> {
  const openIssues = issues.filter(i => i.state !== 'closed').slice(0, 50);
  const issueList = openIssues.map(i =>
    `#${i.number}: ${i.title}\nLabels: ${i.labels.map(l => l.name).join(', ') || 'none'}\nComments: ${i.comments}\nCreated: ${i.created_at.split('T')[0]}\nDescription: ${(i.body ?? '').slice(0, 300)}`
  ).join('\n\n---\n\n');

  const prompt = `You are a software project manager. Analyze these GitHub issues and assign each a priority level.

Issues:
${issueList}

Criteria:
- high: security issues, crashes, data loss, critical bugs blocking users
- medium: regular bugs affecting users, important features, performance problems
- low: minor issues, nice-to-have features, documentation, minor enhancements

Return ONLY valid JSON, no explanation:
{"priorities":[{"number":<n>,"priority":"high"|"medium"|"low","reason":"<one brief sentence>"}]}`;

  const reqBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(reqBody),
        },
        timeout: 30000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as {
              error?: { message: string };
              content?: Array<{ text: string }>;
            };
            if (parsed.error) { reject(new Error(parsed.error.message)); return; }
            const text = parsed.content?.[0]?.text ?? '{}';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) { reject(new Error('No JSON in AI response')); return; }
            const data = JSON.parse(jsonMatch[0]) as {
              priorities?: Array<{ number: number; priority: string; reason: string }>;
            };
            const priorities: IssuePriority[] = (data.priorities ?? []).map(p => ({
              number: p.number,
              priority: (['high', 'medium', 'low'].includes(p.priority) ? p.priority : 'medium') as PriorityLevel,
              score: p.priority === 'high' ? 80 : p.priority === 'medium' ? 50 : 20,
              reason: p.reason ?? '',
            }));
            resolve(priorities);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(reqBody);
    req.end();
  });
}

export async function prioritizeIssues(
  issues: IssueInput[],
  anthropicKey?: string
): Promise<{ priorities: IssuePriority[]; usingAI: boolean }> {
  if (anthropicKey?.trim()) {
    try {
      const priorities = await callAnthropic(issues, anthropicKey.trim());
      return { priorities, usingAI: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[claude-github-issue] Anthropic AI failed, falling back to heuristics:', msg);
    }
  }
  return heuristicPrioritize(issues);
}
