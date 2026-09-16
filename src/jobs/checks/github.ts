import type { CheckContext, CheckResult } from './checkTypes';
import type { GithubIssueCheck, GithubReleaseCheck } from '../jobSchema';

/**
 * The GitHub checks: `github_release` (watch a repo's latest release) and
 * `github_issue` (watch an issue's last-updated time, so a new comment or state
 * change is a change). Both go through the gated `ctx.fetch` (D5) and treat an
 * ETag 304 as "unchanged" so they do not burn the API's rate budget.
 *
 * The observation is a stable JSON string of the structured value the check
 * tracks (B.2). For a release that is the tag, publish time, matching asset
 * names + digests, and a bounded body — the body is what gives a `summarize`
 * action something to work with.
 */

/** Match an asset file name against a `*`-glob pattern (e.g. `*win-cuda-13.3-x64.zip`). */
export function assetMatches(name: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** A bounded body, so a huge release note cannot blow the run log or the prompt. */
const MAX_BODY_CHARS = 4000;

interface ReleaseAsset {
  name?: unknown;
  digest?: unknown;
}

/**
 * Watch a repo's latest release. The observation is a JSON blob of the tag,
 * publish time, matching assets, and a bounded body. It changes when the tag
 * differs (a new release), or when the tag no longer matches the asset pattern.
 */
export async function githubReleaseCheck(
  check: GithubReleaseCheck,
  lastObservation: string | null,
  ctx: CheckContext,
): Promise<CheckResult> {
  const url = `https://api.github.com/repos/${check.repo}/releases/latest`;
  const result = await ctx.fetch(url);

  if (result.notModified) {
    // A 304 means the server has nothing new; the last observation stands.
    return { observation: lastObservation ?? '', changed: false, summary: 'no new release' };
  }

  const release = JSON.parse(result.body) as {
    tag_name?: unknown;
    published_at?: unknown;
    body?: unknown;
    assets?: ReleaseAsset[];
    message?: unknown;
  };
  if (typeof release.tag_name !== 'string') {
    throw new Error(
      `Forge: could not read the latest release for ${check.repo}: ${
        typeof release.message === 'string' ? release.message : 'no tag_name in response'
      }`,
    );
  }
  const tag = release.tag_name;
  const assets = (release.assets ?? [])
    .map((a) => ({
      name: typeof a.name === 'string' ? a.name : '',
      digest: typeof a.digest === 'string' ? a.digest : undefined,
    }))
    .filter((a) => a.name.length > 0 && assetMatches(a.name, check.asset_pattern));

  const observation = JSON.stringify({
    tag,
    published_at: typeof release.published_at === 'string' ? release.published_at : null,
    assets,
    body: typeof release.body === 'string' ? release.body.slice(0, MAX_BODY_CHARS) : '',
  });

  const lastTag = lastObservation ? (JSON.parse(lastObservation) as { tag?: string }).tag : null;
  // The first run only records a baseline; it never reports "changed" (B.2).
  const changed = lastObservation !== null && tag !== lastTag;
  const assetNote =
    assets.length > 0 ? ` (${assets.length} matching asset${assets.length === 1 ? '' : 's'})` : '';
  return {
    observation,
    changed,
    summary: `latest release is ${tag}${assetNote}`,
  };
}

/**
 * Watch an issue. The observation is a JSON blob of the state, updated time,
 * comment count, and last comment. Any field moving is a change (a new comment
 * or a state change). A 304 means nothing changed since the last poll.
 */
export async function githubIssueCheck(
  check: GithubIssueCheck,
  lastObservation: string | null,
  ctx: CheckContext,
): Promise<CheckResult> {
  const url = `https://api.github.com/repos/${check.repo}/issues/${check.issue_number}`;
  const result = await ctx.fetch(url);

  if (result.notModified) {
    return { observation: lastObservation ?? '', changed: false, summary: 'issue unchanged' };
  }

  const issue = JSON.parse(result.body) as {
    state?: unknown;
    updated_at?: unknown;
    title?: unknown;
    comments?: unknown;
    message?: unknown;
  };
  if (typeof issue.updated_at !== 'string') {
    throw new Error(
      `Forge: could not read issue ${check.issue_number} in ${check.repo}: ${
        typeof issue.message === 'string' ? issue.message : 'no updated_at in response'
      }`,
    );
  }
  const state = typeof issue.state === 'string' ? issue.state : 'unknown';
  // The issue payload changes for comments too, but retain the last-comment
  // fact requested by the job model so notifications can say what changed.
  const commentsResult = await ctx.fetch(`${url}/comments?per_page=1&sort=created&direction=desc`);
  let lastComment: { id: number; author: string; excerpt: string } | null = null;
  if (!commentsResult.notModified) {
    const comments = JSON.parse(commentsResult.body) as unknown;
    if (Array.isArray(comments) && comments.length > 0) {
      const comment = comments[0] as { id?: unknown; user?: { login?: unknown }; body?: unknown };
      if (typeof comment.id === 'number') {
        lastComment = {
          id: comment.id,
          author: typeof comment.user?.login === 'string' ? comment.user.login : 'unknown',
          excerpt: typeof comment.body === 'string' ? comment.body.slice(0, 200) : '',
        };
      }
    }
  } else if (lastObservation) {
    const prior = JSON.parse(lastObservation) as { last_comment?: typeof lastComment };
    lastComment = prior.last_comment ?? null;
  }
  const observation = JSON.stringify({
    state,
    updated_at: issue.updated_at,
    title: typeof issue.title === 'string' ? issue.title : '',
    comments: typeof issue.comments === 'number' ? issue.comments : 0,
    last_comment: lastComment,
  });
  // The first run only records a baseline; it never reports "changed" (B.2).
  const changed = lastObservation !== null && observation !== lastObservation;
  return {
    observation,
    changed,
    summary: `issue #${check.issue_number} is ${state}, last updated ${issue.updated_at}`,
  };
}
