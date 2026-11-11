import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENCODED_LABEL_LIMIT,
  ENCODED_RUN_LIMIT,
  PAYLOAD_SEGMENT_LIMIT,
  allowedHostsFor,
  approvedHostsFor,
  clearConversationHostApprovals,
  encodedPayloadChars,
  fetchApprovalFor,
  hostMatchesList,
  hostMatchesPattern,
  isHostApproved,
  markHostApproved,
  normalizedHostname,
  redirectGate,
} from '../../src/tools/fetchHostApprovals';
import {
  clearConversationSecretState,
  markConversationReadSecret,
} from '../../src/tools/exfilTaint';
import { makeWebFetchTool } from '../../src/tools/fetchTool';
import type { ForgeConfig } from '../../src/config/types';

const config = (hosts?: string[]): ForgeConfig =>
  ({ fetch: { allowed_hosts: hosts } }) as unknown as ForgeConfig;
const urlOf = (value: string): URL => new URL(value);

/** These sets are in memory and keyed by chat, so each case uses its own chat id
 *  and clears everything after: a stale flag would make the next case pass for
 *  the wrong reason. */
afterEach(() => {
  clearConversationHostApprovals();
  clearConversationSecretState();
});

describe('the host rules', () => {
  it('matches an exact hostname, case-insensitively', () => {
    expect(hostMatchesPattern('docs.python.org', 'Docs.Python.org')).toBe(true);
    expect(hostMatchesPattern('docs.python.org', 'docs.python.org ')).toBe(true);
    expect(hostMatchesPattern('guide.docs.python.org', 'docs.python.org')).toBe(false);
  });

  // The shape an attacker picks when they can buy the suffix-looking tail of a
  // hostname: `readthedocs.io.collector.net` ENDS WITH the wildcard's suffix as
  // a substring, but the suffix is not one of its labels. Matching on a label
  // boundary is what stops this (docs/plans/EXFIL_GATES_PLAN.md example 2).
  it('matches a wildcard on a label boundary, not as a substring', () => {
    expect(hostMatchesPattern('requests.readthedocs.io', '*.readthedocs.io')).toBe(true);
    expect(hostMatchesPattern('a.b.readthedocs.io', '*.readthedocs.io')).toBe(true);
    expect(hostMatchesPattern('readthedocs.io', '*.readthedocs.io')).toBe(true);
    expect(hostMatchesPattern('readthedocs.io.collector.net', '*.readthedocs.io')).toBe(false);
    expect(hostMatchesPattern('xreadthedocs.io', '*.readthedocs.io')).toBe(false);
    expect(hostMatchesPattern('', '*.readthedocs.io')).toBe(false);
    expect(hostMatchesPattern('anything', '*')).toBe(false);
    expect(hostMatchesPattern('anything', '')).toBe(false);
  });

  it('defaults to an empty list, so everything asks until the owner says otherwise', () => {
    expect(allowedHostsFor(undefined)).toEqual([]);
    expect(allowedHostsFor(config())).toEqual([]);
    expect(allowedHostsFor(config(['github.com', '*.readthedocs.io']))).toEqual([
      'github.com',
      '*.readthedocs.io',
    ]);
    expect(
      allowedHostsFor({ fetch: { allowed_hosts: [42, 'github.com'] } } as unknown as ForgeConfig),
    ).toEqual(['github.com']);
  });

  it('normalises a hostname the one way both gates use', () => {
    expect(normalizedHostname(urlOf('https://Docs.Python.org/3/'))).toBe('docs.python.org');
    expect(normalizedHostname(urlOf('https://[::1]:3333/unload'))).toBe('::1');
  });
});

describe('what counts as a payload', () => {
  it('leaves ordinary URLs alone', () => {
    for (const value of [
      'https://github.com/microsoft/vscode/issues/1234',
      'https://docs.python.org/3/library/asyncio-task.html',
      'https://pypi.org/project/httpx/?o=desc',
      'https://example.com/search?q=forge+vscode+extension',
    ]) {
      expect(encodedPayloadChars(urlOf(value))).toBe(0);
    }
  });

  // A base64 run this long cannot be a word someone typed. The thresholds are
  // constants so the owner can tune them without guessing where they live, and
  // they are measured per value: `?q=<63 characters>` is a long search term, not
  // a payload, even though `?d=` in front of it would make 65 characters.
  it('catches an encoded run and a long segment', () => {
    expect(ENCODED_RUN_LIMIT).toBe(64);
    expect(PAYLOAD_SEGMENT_LIMIT).toBe(512);
    const key = 'LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnphQzFyWldr';
    expect(encodedPayloadChars(urlOf(`https://collector.example.net/p?d=${key}`))).toBe(
      key.length,
    );
    expect(encodedPayloadChars(urlOf(`https://example.com/?q=${'a'.repeat(63)}`))).toBe(0);
    expect(encodedPayloadChars(urlOf(`https://example.com/?q=${'a'.repeat(64)}`))).toBe(64);
    const long = 'AKIAIOSFODNN7EXAMPLE'.repeat(35);
    expect(encodedPayloadChars(urlOf(`https://github.com/search?q=${long}`))).toBe(long.length);
    expect(encodedPayloadChars(urlOf(`https://example.com/${'seg'.repeat(200)}`))).toBe(600);
    // URL-safe base64 and hex are the same payload in a different alphabet.
    expect(encodedPayloadChars(urlOf(`https://x.example.net/?d=${'a-_'.repeat(30)}`))).toBe(90);
    expect(encodedPayloadChars(urlOf(`https://x.example.net/?d=${'ff00'.repeat(16)}`))).toBe(64);
    // Two ordinary parameters do not add up to a payload: neither is carrying
    // data, and a gate that fires on arithmetic is a gate that gets switched off.
    expect(encodedPayloadChars(urlOf(`https://x.example.net/?a=${'b'.repeat(40)}&c=${'d'.repeat(40)}`))).toBe(0);
  });
});

describe('the hostname and the user info, which the path and query rule cannot see', () => {
  // S2, Claude's review of 887d2e69: `encodedPayloadChars` measured path
  // segments and query values only. A collector that puts the payload in the
  // labels above its own domain, or in the user info, carries it out with an
  // empty path and an empty query — and a NEW host is the ordinary card that
  // `/clanker` and an unattended turn approve without anyone reading it.
  //
  // The follow-up review of bfa8ed5e: the first host rule asked for mixed case,
  // and WHATWG `URL` lower-cases every ASCII hostname, so that test was dead for
  // a label — base32 (`a-z2-7`), the usual DNS exfil encoding, is all lower
  // case. These are named by their true length, and the lengths are asserted.
  const b64Label64 = 'LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnphQzFy';
  const b64Label60 = 'LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZLS0tLS0KYjNCbGJuTnph';
  const b64Label40 = 'LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZ';
  const b32Label60 = 'mfrggzdfmztwq2lknnwg23tpobyxe43uov3ho6dzpiysm4ztgq2tknzyhe4q';
  const hexLabel32 = 'd41d8cd98f00b204e9800998ecf8427e';

  it('pins the two thresholds and the lengths these cases claim', () => {
    // 64 is a base64 run; 32 is what a DNS label can actually reach, since a
    // label tops out at 63 characters and 64 can never match inside one. A
    // mislabelled constant here would make the single-label test measure the
    // sum arm instead of the label arm, which is exactly the mistake this
    // review caught.
    expect(ENCODED_RUN_LIMIT).toBe(64);
    expect(ENCODED_LABEL_LIMIT).toBe(32);
    expect([b64Label64.length, b64Label60.length, b64Label40.length]).toEqual([64, 60, 40]);
    expect(b32Label60.length).toBe(60);
    expect(hexLabel32.length).toBe(32);
  });

  it('catches a payload split across the labels above the collector domain', () => {
    const url = `https://${b64Label64}.${b64Label60}.collector.net/`;
    expect(encodedPayloadChars(urlOf(url))).toBe(b64Label64.length + b64Label60.length);
    // Even on a domain the owner listed: the wildcard covers the label, not the
    // data riding above it, so this stays a dangerous card that an unattended
    // run refuses at once rather than approving free.
    const card = fetchApprovalFor(url, config(['*.collector.net']), 'chat-30');
    expect(card?.dangerous).toBe(true);
    expect(card?.gateKind).toBe('ownerGate');
    expect(card?.cardReason).toContain('characters of encoded data');
  });

  // A single label cannot reach 64 characters, so the 64-character run rule is
  // dead inside a hostname, and the host is lower-cased, so a rule that asked
  // for mixed case was dead there too. These are the shapes a collector actually
  // picks: 45 bytes of base64 in one label, 37 bytes of base32 (`a-z2-7`, all
  // lower case), and 30 bytes of base64 in a 40-character label — every one
  // under the 64-character sum bar, so only the label bar can see them.
  it('catches one long encoded label, which the 64-character run rule can never see', () => {
    for (const label of [b64Label64, b64Label60, b64Label40, b32Label60, hexLabel32]) {
      expect([label.length, encodedPayloadChars(urlOf(`https://${label}.collector.net/`))]).toEqual(
        [label.length, label.length],
      );
    }
  });

  // The shape that moved out of the clear list when the host rule became
  // lower-case aware, and why: a 32-character label of `[a-z0-9]` with digits in
  // it IS the base32/hex payload shape, so asking about it is the rule working,
  // not a false positive. The CDN hash host that stays clear is CloudFront's
  // 14-character label, below `ENCODED_LABEL_LIMIT`, in the list below.
  it('asks about a 32-character hash label, the shape base32 exfil uses', () => {
    expect(
      encodedPayloadChars(urlOf('https://a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6.assets.example.net/')),
    ).toBe(32);
    expect(
      encodedPayloadChars(urlOf('https://mfrggzdfmztwq2lknnwg23tpobyxe43u.assets.example.net/')),
    ).toBe(32);
  });

  it('catches a payload in the user name and in the password', () => {
    // User info keeps its case, so it still gets the mixed-case rule; a 60-char
    // value is checked with a real 60-character piece, not with a 64-character
    // one that would also pass the sum bar.
    expect(encodedPayloadChars(urlOf(`https://${b64Label64}@collector.net/`))).toBe(64);
    expect(encodedPayloadChars(urlOf(`https://${b64Label60}@collector.net/`))).toBe(60);
    expect(encodedPayloadChars(urlOf(`https://u:${b64Label60}@collector.net/`))).toBe(60);
    expect(encodedPayloadChars(urlOf(`https://${b32Label60}@collector.net/`))).toBe(60);
    // `url.username` keeps the percent-escape, and `%2B` is still a `+`: the
    // user info is measured decoded, the way a query value already was. Raw,
    // this piece is 37 characters with `%` in it and measures 0.
    expect(
      encodedPayloadChars(urlOf('https://aB%2B345678901234567890123456789012AB@collector.net/')),
    ).toBe(35);
    // A malformed escape is measured as it stands: a gate must not throw on a
    // URL it is only judging.
    expect(encodedPayloadChars(urlOf('https://%zzuser@collector.net/'))).toBe(0);
  });

  // The other half of a host rule: a gate that fires on the hosts the agent
  // really fetches is a gate the owner switches off. Every one of these is a
  // real hostname shape and must measure 0 — the deep chains, the hyphenated
  // service names, the hash labels CDNs really use, and the 37-character ELB
  // label `alb-<hex>-<hex>`, whose runs are 3, 16 and 16 because the hyphens
  // break them: a rule that counted the whole label would have flagged it.
  it('leaves the hosts the agent really fetches alone', () => {
    for (const value of [
      'https://docs.python.org/3/library/asyncio-task.html',
      'https://raw.githubusercontent.com/microsoft/vscode/main/README.md',
      'https://d3gqalsDGqTcdq.cloudfront.net/a/b/asset.js',
      'https://d1f5g8h2i4j6k8.cloudfront.net/a/b/style.css',
      'https://my-bucket-name.s3.amazonaws.com/report.pdf',
      'https://mycontainer.blob.core.windows.net/report.csv',
      'https://dualstack.alb-1234567890abcdef-1234567890abcdef.us-east-1.elb.amazonaws.com/health',
      'https://alb-1234567890abcdef-1234567890abcdef.elb.amazonaws.com/health',
      'https://my-app-name.herokuapp.com/',
      'https://builds.travis-ci.org/microsoft/vscode/builds',
      'https://developer-tools.docs.example.net/',
      'https://some-really-long-service-name.prod.example.net/',
      'https://my-service-name-without-any-digits-but-quite-long.internal.example.net/',
      'https://a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.example.net/',
      'https://en.wikipedia.org/wiki/Forge_(software)',
      'https://fonts.googleapis.com/css?family=Roboto',
      'https://s3.us-west-2.amazonaws.com/bucket/key',
      'https://s3.eu-central-1.amazonaws.com/bucket/key',
      'https://dev1234.okta.com/app/',
      'https://mycompany.atlassian.net/browse/PROJ-1234',
      'https://hooks.slack.com/services/T01234567/B01234567/xxxxxxx',
      'https://cdn.shopify.com/s/files/1/0123/4567/products/logo.png',
      'https://my-topic-subscription.pubsub.googleapis.com/modify',
      'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
      'https://unpkg.com/three@0.160.0/build/three.module.js',
      'https://pypi.org/simple/numpy/',
      'https://github.com/microsoft/vscode/issues/1234',
      'https://requests.readthedocs.io/en/latest/',
      'https://www.google.com/search?q=forge+vscode+extension',
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo.png',
      'https://registry-1.docker.io/v2/library/node/manifests/latest',
      'https://images.example.net.edgekey.net/a/b/image.png',
      'https://localhost:8080/unload',
      'https://8.8.8.8/dns-query',
    ]) {
      expect([value, encodedPayloadChars(urlOf(value))]).toEqual([value, 0]);
    }
  });

  // Order matters: the secret read is still judged first, so a hash-label
  // collector in a tainted chat is the `taintGate` card, never the `ownerGate`
  // one.
  it('keeps a payload in a tainted chat owner-only and unkeyable', () => {
    markConversationReadSecret('chat-31', '**/.env', 'read_file .env');
    const card = fetchApprovalFor(
      `https://${b64Label64}.collector.net/`,
      config(['collector.net']),
      'chat-31',
    );
    expect(card?.gateKind).toBe('taintGate');
    expect(card?.cardReason).toContain('**/.env');
    expect(card?.cardReason).toContain('read_file .env');
    expect(card?.approvalKey).toBeUndefined();
    expect(card?.secretReadTaint).toBe(true);
  });

  it('leaves a new host with an ordinary long label the ordinary card it was', () => {
    const card = fetchApprovalFor(
      'https://some-really-long-service-name.prod.example.net/',
      config([]),
      'chat-32',
    );
    expect(card?.dangerous).toBe(false);
    expect(card?.gateKind).toBeUndefined();
    expect(card?.cardReason).toBe(
      'new host for this chat: some-really-long-service-name.prod.example.net',
    );
  });
});

describe('what a fetch needs before it runs', () => {
  // Rule 3: the card shows the full URL, query included, because the query is
  // where stolen data travels. A card that showed only the host would let
  // `?d=<1842 characters of key>` pass under a decision made about the host.
  it('shows the whole URL on a new host, and asks as an ordinary card', () => {
    const card = fetchApprovalFor(
      'https://docs.python.org/3/library/asyncio-task.html?x=1#section',
      config([]),
      'chat-1',
    );
    expect(card?.dangerous).toBe(false);
    expect(card?.cardReason).toBe('new host for this chat: docs.python.org');
    expect(card?.detail).toBe(
      'GET https://docs.python.org/3/library/asyncio-task.html?x=1#section',
    );
    // An ordinary card, so `/clanker` and an unattended turn approve it and no
    // gate in this plan stalls a run (rule 6).
    expect(card?.gateKind).toBeUndefined();
  });

  it('does not ask for a host the owner listed, or one this chat approved', () => {
    // "Does not ask" still means no card: what these two return now is the card's
    // TEXT plus the key, marked `cardTextOnly`, which `ToolDispatch` does not count
    // as a gate (`approvalKey.ts` needs the key so a flagged chat's card for the
    // same fetch can be answered by an approval this chat already holds).
    const listed = fetchApprovalFor(
      'https://requests.readthedocs.io/en/latest/',
      config(['*.readthedocs.io']),
      'chat-2',
    );
    expect(listed?.cardTextOnly).toBe(true);
    expect(listed?.dangerous).toBe(false);
    expect(listed?.cardReason).toBeUndefined();
    expect(listed?.approvalKey).toBe('net:requests.readthedocs.io');
    markHostApproved('chat-2', 'pypi.org');
    const approved = fetchApprovalFor('https://pypi.org/project/httpx/', config([]), 'chat-2');
    expect(approved?.cardTextOnly).toBe(true);
    expect(approved?.cardReason).toBeUndefined();
    expect(approved?.approvalKey).toBe('net:pypi.org');
    // Same host, different chat: the set is per chat, so a new chat asks again.
    expect(fetchApprovalFor('https://pypi.org/project/httpx/', config([]), 'chat-3')?.cardReason).toBe(
      'new host for this chat: pypi.org',
    );
    expect(fetchApprovalFor('https://pypi.org/project/httpx/', config([]), undefined)?.cardReason).toBe(
      'new host for this chat: pypi.org',
    );
  });

  // Rule 4: an approved host is not a licence to send a payload. The attacker who
  // controls the query controls the data, and `github.com` being allowed says
  // nothing about a 1,842-character value riding out on it.
  it('asks, as dangerous, for an encoded payload even on an approved host', () => {
    const card = fetchApprovalFor(
      `https://collector.example.net/p?d=${'LS0tLS1CRUdJTiB'.repeat(8)}`,
      config(['collector.example.net']),
      'chat-4',
    );
    expect(card?.dangerous).toBe(true);
    expect(card?.cardReason).toContain('characters of encoded data');
    expect(card?.detail).toContain('d=LS0tLS1CRUdJTiB');
    // An autonomous run refuses this at once, naming the alternative, because
    // this gate is one only the owner may answer (docs/plans/V1_FINISH_PLAN.md,
    // autonomous-run table).
    expect(card?.gateKind).toBe('ownerGate');
    expect(card?.declineHint).toContain('fetch.allowed_hosts');
  });

  // The core row of the design: reading a secret and then sending it out is the
  // exfiltration. `taintGate` is what makes the second half wait for the owner in
  // an attended chat and get refused at once in an autonomous one.
  it('asks, as dangerous, after this chat read a secret', () => {
    markConversationReadSecret('chat-5', '~/.ssh/**', 'shell "cat ~/.ssh/id_rsa"');
    const card = fetchApprovalFor(
      'https://docs.python.org/3/library/asyncio-task.html',
      config(['docs.python.org']),
      'chat-5',
    );
    expect(card?.dangerous).toBe(true);
    expect(card?.gateKind).toBe('taintGate');
    expect(card?.cardReason).toContain('~/.ssh/**');
    expect(card?.cardReason).toContain('cat ~/.ssh/id_rsa');
    expect(card?.approvalKey).toBe('secret-net:docs.python.org');
    // A payload on top of the taint stays owner-only and cannot be answered by
    // the otherwise valid after-secret-read host rule.
    const payload = fetchApprovalFor(
      `https://docs.python.org/?d=${'QUJD'.repeat(20)}`,
      config([]),
      'chat-5',
    );
    expect(payload?.gateKind).toBe('taintGate');
    expect(payload?.approvalKey).toBeUndefined();
    // A chat that read nothing is judged on its host rules alone: the owner listed
    // the host, so nothing is asked (`cardTextOnly` is not a gate).
    const listedForChat6 = fetchApprovalFor(
      'https://docs.python.org/3/',
      config(['docs.python.org']),
      'chat-6',
    );
    expect(listedForChat6?.cardTextOnly).toBe(true);
    expect(listedForChat6?.cardReason).toBeUndefined();
  });

  it('leaves a URL this cannot read to web_fetch own error', () => {
    expect(fetchApprovalFor('not a url', config(['example.com']), 'chat-7')).toBeUndefined();
    expect(fetchApprovalFor('', config(['example.com']), 'chat-7')).toBeUndefined();
  });
});

describe('the per-chat approved set', () => {
  it('remembers the host for the chat that earned it, and for no other', () => {
    markHostApproved('chat-8', 'Collector.Example.Net');
    expect(isHostApproved('chat-8', 'collector.example.net')).toBe(true);
    expect(isHostApproved('chat-9', 'collector.example.net')).toBe(false);
    expect(approvedHostsFor('chat-8')).toEqual(['collector.example.net']);
    expect(approvedHostsFor('chat-9')).toEqual([]);
    expect(isHostApproved(undefined, 'collector.example.net')).toBe(false);
    // A read with no chat cannot earn an approval, so it cannot leave one behind.
    markHostApproved(undefined, 'collector.example.net');
    expect(approvedHostsFor(undefined)).toEqual([]);
  });

  // Ledger row: cleared on chat close, `/clearChat` and window reload — never
  // written to disk, so a crash loses it and Forge asks again (fails safe).
  it('clears with the chat, and only that chat', () => {
    markHostApproved('chat-10', 'a.example.net');
    markHostApproved('chat-10', 'b.example.net');
    markHostApproved('chat-11', 'a.example.net');
    clearConversationHostApprovals('chat-10');
    expect(approvedHostsFor('chat-10')).toEqual([]);
    expect(isHostApproved('chat-11', 'a.example.net')).toBe(true);
    clearConversationHostApprovals();
    expect(isHostApproved('chat-11', 'a.example.net')).toBe(false);
  });
});

describe('the redirect gate', () => {
  // Rule 5: an open redirect on an approved host (`www.google.com/url?q=…`) would
  // otherwise launder a request to any host on the internet under a card the user
  // answered for a different one.
  it('refuses a target this chat has not approved, and names the next step', () => {
    const gate = redirectGate(config(['www.google.com', 'docs.python.org']), 'chat-12');
    markHostApproved('chat-12', 'pypi.org');
    markHostApproved('chat-13', 'other-chat.example.net');
    const blocked = gate(urlOf('https://collector.example.net/?d=secret'));
    expect(blocked).toContain('the redirect goes to collector.example.net');
    expect(blocked).toContain('was not followed');
    expect(blocked).toContain('fetch.allowed_hosts or approved earlier in this chat');
    expect(blocked).toContain('docs.python.org, pypi.org, www.google.com');
    expect(blocked).not.toContain('other-chat.example.net');
    expect(blocked).toContain('To get another host approved');
    expect(blocked).toContain('call web_fetch with https://collector.example.net/?d=secret directly');
    expect(gate(urlOf('https://www.google.com/search'))).toBeUndefined();
    markHostApproved('chat-12', 'collector.example.net');
    expect(gate(urlOf('https://collector.example.net/?d=secret'))).toBeUndefined();
  });

  it('caps the approved host list at ten and reports the remainder', () => {
    const configured = Array.from({ length: 12 }, (_, index) => `host-${index.toString().padStart(2, '0')}.example`);
    markHostApproved('chat-12-cap', 'session.example');
    const blocked = redirectGate(config(configured), 'chat-12-cap')!(
      urlOf('https://new.example/path'),
    );
    expect(blocked).toContain('host-00.example');
    expect(blocked).toContain('host-09.example');
    expect(blocked).not.toContain('host-10.example');
    expect(blocked).toContain('plus 3 more');
  });

  // The gate closes the moment the chat does, so a redirect that was followed in
  // one chat is not free in the next one that reuses the same tool instance.
  it('stops following a host the cleared chat no longer approves', () => {
    const gate = redirectGate(config([]), 'chat-13');
    markHostApproved('chat-13', 'cdn.example.net');
    expect(gate(urlOf('https://cdn.example.net/a.js'))).toBeUndefined();
    clearConversationHostApprovals('chat-13');
    expect(gate(urlOf('https://cdn.example.net/a.js'))).toContain('not approved in this chat');
  });
});

describe('web_fetch carries the gate to the card and to the result', () => {
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const page = (body: string) => async () =>
    new Response(body, { headers: { 'content-type': 'text/html' } });

  function tool(handlers: { lookup?: () => Promise<{ address: string; family: number }[]>; fetch?: () => Promise<Response>; hosts?: string[] }) {
    return makeWebFetchTool({
      lookup: (handlers.lookup ?? publicLookup) as never,
      fetch: (handlers.fetch ?? page('<p>page</p>')) as never,
      ...(handlers.hosts ? { getConfig: () => config(handlers.hosts) } : {}),
    });
  }

  it('asks for a new host with the full URL and the host named', () => {
    const card = tool({}).approval?.(
      { url: 'https://docs.python.org/3/library/asyncio-task.html' },
      { conversationId: 'fetch-20' },
    );
    expect(card?.detail).toBe('GET https://docs.python.org/3/library/asyncio-task.html');
    expect(card?.cardReason).toBe('new host for this chat: docs.python.org');
    expect(card?.dangerous).toBe(false);
    expect(
      tool({ hosts: ['docs.python.org'] }).approval?.({ url: 'https://docs.python.org/3/' }),
    ).toMatchObject({ cardTextOnly: true, approvalKey: 'net:docs.python.org' });
  });

  // Rule 6: the host is logged in the result, so an autonomous run that never
  // saw a card still shows what it let out, and the model can see the approval
  // was consumed.
  it('notes a new host in the result, then stops noting it for the rest of the chat', async () => {
    const fetchTool = tool({ fetch: page('<p>hello</p>') });
    const first = String(
      await fetchTool.handler({ url: 'https://pypi.org/project/httpx/' }, { conversationId: 'fetch-21', beforeMutate: () => undefined } as never),
    );
    expect(first).toContain('[host pypi.org was new to this chat; approved for the rest of it]');
    const second = String(
      await fetchTool.handler({ url: 'https://pypi.org/project/numpy/' }, { conversationId: 'fetch-21', beforeMutate: () => undefined } as never),
    );
    expect(second).not.toContain('was new to this chat');
    const otherChat = String(
      await fetchTool.handler({ url: 'https://pypi.org/project/scipy/' }, { conversationId: 'fetch-22', beforeMutate: () => undefined } as never),
    );
    expect(otherChat).toContain('was new to this chat');
    // The note sits above the fence, so a page still cannot close the fence and
    // append text after Forge's own metadata (`WebFetchSsrf.test.ts` pins the
    // closing tag as the last thing in the result).
    expect(second.trimEnd().endsWith('</UNTRUSTED_CONTENT>')).toBe(true);
  });

  it('does not note a host the owner listed', async () => {
    const out = String(
      await tool({ hosts: ['pypi.org'] }).handler(
        { url: 'https://pypi.org/project/httpx/' },
        { conversationId: 'fetch-23', beforeMutate: () => undefined } as never,
      ),
    );
    expect(out).not.toContain('was new to this chat');
  });

  it('asks the dispatcher before following a redirect to a new host', async () => {
    const lookups: string[] = [];
    const fetches: string[] = [];
    const ask = vi.fn(async () => undefined);
    const fetchTool = makeWebFetchTool({
      lookup: (async (hostname: string) => {
        lookups.push(hostname);
        return [{ address: '8.8.8.8', family: 4 }];
      }) as never,
      fetch: (async (url: string) => {
        fetches.push(url);
        if (url.includes('start')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://collector.example.net/p?d=secret' },
          });
        }
        return new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } });
      }) as never,
      getConfig: () => config(['origin.example.test']),
    });
    const out = String(
      await fetchTool.handler(
        { url: 'https://origin.example.test/start' },
        {
          conversationId: 'fetch-24',
          beforeMutate: () => undefined,
          authorizeFetchRedirect: ask,
        } as never,
      ),
    );
    expect(ask).toHaveBeenCalledExactlyOnceWith('https://collector.example.net/p?d=secret');
    expect(lookups).toEqual(['origin.example.test', 'collector.example.net']);
    expect(fetches).toEqual([
      'https://origin.example.test/start',
      'https://collector.example.net/p?d=secret',
    ]);
    expect(out).toContain('page');
    expect(isHostApproved('fetch-24', 'collector.example.net')).toBe(true);
  });

  it('follows a redirect to a host the owner listed', async () => {
    const fetches: string[] = [];
    const fetchTool = makeWebFetchTool({
      lookup: publicLookup as never,
      fetch: (async (url: string) => {
        fetches.push(url);
        return url.includes('start')
          ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/a.html' } })
          : new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } });
      }) as never,
      getConfig: () => config(['origin.example.test', 'cdn.example.net']),
    });
    const out = String(
      await fetchTool.handler(
        { url: 'https://origin.example.test/start' },
        { conversationId: 'fetch-25', beforeMutate: () => undefined } as never,
      ),
    );
    expect(fetches).toHaveLength(2);
    expect(out).toContain('page');
    expect(out).not.toContain('was new to this chat');
  });

  it('does not ask again for a redirect on the direct call host', async () => {
    const ask = vi.fn(async () => undefined);
    const fetchTool = makeWebFetchTool({
      lookup: publicLookup as never,
      fetch: (async (url: string) =>
        url.endsWith('/start')
          ? new Response(null, { status: 302, headers: { location: '/next' } })
          : new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })) as never,
      getConfig: () => config([]),
    });

    await fetchTool.handler(
      { url: 'https://same-host.example/start' },
      {
        conversationId: 'fetch-same-host',
        beforeMutate: () => undefined,
        authorizeFetchRedirect: ask,
      } as never,
    );

    expect(ask).not.toHaveBeenCalled();
  });

  it('does not ask again for a host already approved earlier in this chat', async () => {
    const ask = vi.fn(async () => undefined);
    markHostApproved('fetch-prior-approval', 'cdn.example.net');
    const fetchTool = makeWebFetchTool({
      lookup: publicLookup as never,
      fetch: (async (url: string) =>
        url.endsWith('/start')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.net/asset' },
            })
          : new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })) as never,
      getConfig: () => config(['origin.example.test']),
    });

    await fetchTool.handler(
      { url: 'https://origin.example.test/start' },
      {
        conversationId: 'fetch-prior-approval',
        beforeMutate: () => undefined,
        authorizeFetchRedirect: ask,
      } as never,
    );

    expect(ask).not.toHaveBeenCalled();
  });

});
