# Sharing one llama-server across windows

The detail behind the README's summary: what is and is not shared, how the
token counter behaves, and the setting people reach for that does not do what
they expect. Moved out of `README.md` because that file is also the Marketplace
Overview page, and a log line about LCP similarity is not what a store visitor
came for.

Opt-in, off unless you enable it:

```yaml
shared_runtime:
  enabled: true
```

With it on, a second VS Code window asking for a model another window already
loaded **borrows that running llama-server** instead of spawning its own. One
copy of the weights in VRAM. The borrowing window takes a lease; the owner will
not shut the server down while a lease is outstanding, and a lease left behind
by a window that crashed is reclaimed once its process is confirmed gone.

### What is and is not shared

**Conversation history is not shared.** Each window keeps its own tabs, its own
messages, its own checkpoints. Windows share the loaded weights, nothing else.

**KV cache slots are shared, and this is the part that surprises people.**
`--parallel` divides `--ctx-size` into N slots, and every borrowing window draws
from that same pool. With the default single slot, two windows take turns on one
cache, and llama.cpp picks up whatever the last conversation left behind by
prefix similarity:

```
slot get_availabl: id 0 | selected slot by LCP similarity, f_sim_best = 0.949
```

Alternating windows evict each other's cached prefix, so each pays full prompt
re-processing — an 8k prompt costs about 10 s of eval on a miss instead of near
zero on a hit. Answers stay correct (the whole prompt is sent every time); you
only lose the cache speedup.

### How the token counter behaves

Each window counts **its own** conversation against `perSlotContext()` —
`num_ctx / n_parallel`, not `num_ctx`. Both windows compute the same per-slot
ceiling and measure only their own messages, so compaction triggers per window
on that window's history. A borrowing window has no idea the other exists.

That number describes the _slot_. With `--parallel 1` there is one slot serving
both windows: neither is over its limit, but they contend for one cache.
Compaction stays correct — it simply cannot see the contention.

### If you have VRAM to spare

`max_simultaneous_models` is **not** the setting for this. It controls how many
_different_ models Forge keeps loaded at once. Two windows asking for the same
model resolve to the same runtime key and share one server regardless — that is
the feature working as designed.

Two real options:

- **Independent servers** — set `shared_runtime.enabled: false`. Each window
  spawns its own llama-server with its own full context and no contention, at
  double the VRAM. That is precisely the cost sharing exists to avoid.
- **Keep sharing, drop the thrashing** — raise `--parallel` to 2 or more so each
  window gets its own slot. `--ctx-size` is the _total_ and gets divided, so
  `--parallel 2` halves each window's context unless you raise `--ctx-size` to
  match.

For two windows on a large card the second option is the better trade: one copy
of the weights, two independent caches.

