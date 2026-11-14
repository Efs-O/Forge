#!/usr/bin/env python3
"""Lab state machine for the overnight tool-test run (Forge-owned, lab script).

Why this exists (owner asked Codex to review the keep-alive design, 2026-11-09 00:51).
Codex's findings, and what this file does about each one:
  A. A chat id identifies the teacher, not an executing turn -- two overlapping ticks can
     share it. -> ownership is authorised by an exclusive LOCK with a lease, not by the
     heartbeat text. The heartbeat still says who is responsible; the lock says who may act.
  B. Persist the batch BEFORE launching, end the turn, reconcile on the next tick. -> every
     student is written as `planned` before it is fired, then `launched` with its chat id and
     log path, then `verdicted` with the evidence line. A cancelled turn loses nothing.
  C. Read-check-rewrite of a heartbeat is not atomic. -> the lock is created with O_EXCL
     (never overwritten by an existing holder); takeover needs the lease to have expired and
     bumps `generation`, which is written into the lock so a stale holder can be spotted.
  D. The silent failure is a fresh heartbeat with zero completed work. -> `show` reports
     minutes since the last VERDICT separately from the beat, and flags STALLED past
     `progress_deadline_minutes`. Timestamps are full ISO-8601 with offset: `HH:MM` is wrong
     across midnight. The 05:30 cutoff is stored, so a tick knows to stop launching early
     enough to finish verdicts.

Ambiguous dispatch (crash after launch, before the receipt): do NOT fire again. Reconcile by
listing the target window's chats (message_chat action=list) and matching the task text to the
owed dispatch_key; if it exists, record it; if not, mark the key `ambiguous` and move on.

Usage:
  python scripts/session-scan/lab_state.py show
  python scripts/session-scan/lab_state.py acquire [--owner <chat-id>] [--run <run-id>] [--minutes N]
  python scripts/session-scan/lab_state.py plan    <dispatch_key> <test/arm> [<note>]
  python scripts/session-scan/lab_state.py launch  <dispatch_key> <chat-id>
  python scripts/session-scan/lab_state.py verdict <dispatch_key> <PASS|FAIL|BLOCKED> <note>
  python scripts/session-scan/lab_state.py release
"""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "lab-state.json")
LOCK = os.path.join(HERE, "lab.lock")
DEFAULT_LEASE_MIN = 25          # ticks are 20 min apart; a lease outlives one tick, not two
PROGRESS_DEADLINE_MIN = 75      # no verdict at all for this long => STALLED, not healthy
CUTOFF_LOCAL = "2026-11-09T05:30:00+02:00"


def now():
    return dt.datetime.now().astimezone()


def iso(moment=None):
    return (moment or now()).isoformat(timespec="seconds")


def parse(text):
    if not text:
        return None
    try:
        return dt.datetime.fromisoformat(text)
    except ValueError:
        return None


def load():
    if not os.path.exists(STATE):
        return {"lab_run_id": None, "generation": 0, "owner_chat_id": None,
                "heartbeat_at": None, "lease_expires_at": None,
                "cutoff_local": CUTOFF_LOCAL, "progress_deadline_minutes": PROGRESS_DEADLINE_MIN,
                "students": [], "queue_done": [], "notes": []}
    with open(STATE, encoding="utf-8") as handle:
        return json.load(handle)


def save(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp, STATE)


def find(state, key):
    for student in state["students"]:
        if student["dispatch_key"] == key:
            return student
    return None


def acquire(state, owner, run, minutes):
    """Exclusive acquisition. Existing lock with a live lease => defer (exit 3)."""
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    try:
        fd = os.open(LOCK, flags)
    except FileExistsError:
        try:
            with open(LOCK, encoding="utf-8") as handle:
                held = json.load(handle)
        except (OSError, ValueError):
            held = {}
        lease = parse(held.get("lease_expires_at"))
        if held.get("owner_chat_id") == owner:
            # The lock is MINE (same chat, earlier tick). Renewing must never be a reason to
            # idle -- the teacher is this job's own chat, so a live lease is the normal case.
            # Renewing must also EXTEND the lease: the early return used to leave the old
            # expiry in place, so a holder that renewed every tick still looked expired and
            # the watchdog could steal the lock mid-work (found 02:22 by reading the file).
            lease_until = now() + dt.timedelta(minutes=minutes)
            held["heartbeat_at"] = iso()
            held["lease_expires_at"] = lease_until.isoformat(timespec="seconds")
            try:
                with open(LOCK, "w", encoding="utf-8") as handle:
                    handle.write(json.dumps(held, indent=2, ensure_ascii=False) + "\n")
            except OSError:
                    pass
            state["heartbeat_at"] = iso()
            state["lease_expires_at"] = held["lease_expires_at"]
            save(state)
            print(f"RENEWED my own lease (gen {held.get('generation')}) -- work the queue, "
                  f"lease until {held['lease_expires_at']}")
            return 0
        if lease and lease > now():
            print(f"DEFER: lock held by {held.get('owner_chat_id')} "
                  f"(run {held.get('lab_run_id')}, gen {held.get('generation')}), "
                  f"lease live until {held.get('lease_expires_at')}")
            return 3
        # Lease expired: take over, bumping the generation so an old holder is detectable.
        try:
            os.remove(LOCK)
        except OSError:
            pass
        try:
            fd = os.open(LOCK, flags)
        except FileExistsError:
            print("DEFER: lost the takeover race; another tick holds the lock")
            return 3
        state["generation"] = state.get("generation", 0) + 1
        print(f"TOOK OVER from expired lease; generation now {state['generation']}")
    else:
        state["generation"] = state.get("generation", 0) + 1
    lease_until = now() + dt.timedelta(minutes=minutes)
    lock = {"lab_run_id": run or state.get("lab_run_id"), "owner_chat_id": owner,
            "owner_run_id": iso(), "generation": state["generation"],
            "heartbeat_at": iso(), "lease_expires_at": lease_until.isoformat(timespec="seconds"),
            "phase": "reconcile"}
    os.write(fd, (json.dumps(lock, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    os.close(fd)
    state["owner_chat_id"] = owner
    state["lab_run_id"] = run or state.get("lab_run_id")
    state["heartbeat_at"] = iso()
    state["lease_expires_at"] = lock["lease_expires_at"]
    save(state)
    print(f"ACQUIRED gen {state['generation']} owner {owner} lease until {lock['lease_expires_at']}")
    return 0


def show(state):
    beat = parse(state.get("heartbeat_at"))
    last_verdict = None
    for student in state["students"]:
        stamp = parse(student.get("verdict_at"))
        if stamp and (last_verdict is None or stamp > last_verdict):
            last_verdict = stamp
    open_students = [s for s in state["students"] if s["status"] != "verdicted"]
    print(f"run {state.get('lab_run_id')} gen {state.get('generation')} owner {state.get('owner_chat_id')}")
    print(f"now {iso()} | beat {state.get('heartbeat_at')} | lease {state.get('lease_expires_at')}")
    print(f"students {len(state['students'])} total, {len(open_students)} not verdicted")
    for student in state["students"]:
        print(f"  {student['dispatch_key']:14s} {student['status']:10s} "
              f"chat {student.get('chat_id') or '-':12s} {student.get('note', '')[:60]}")
    deadline = state.get("progress_deadline_minutes", PROGRESS_DEADLINE_MIN)
    if last_verdict:
        quiet = (now() - last_verdict).total_seconds() / 60
        flag = "STALLED" if quiet > deadline else "ok"
        print(f"minutes since last VERDICT: {quiet:.0f} (deadline {deadline}) -> {flag}")
    else:
        print("minutes since last VERDICT: none recorded -> STALLED unless a batch is in flight")
    cutoff = parse(state.get("cutoff_local"))
    if cutoff:
        left = (cutoff - now()).total_seconds() / 60
        print(f"cutoff {state['cutoff_local']}: {left:.0f} minutes of launch window left"
              f"{' -- STOP LAUNCHING, finish verdicts and write the summary' if left < 25 else ''}")
    return 0


def plan(state, key, test, note=""):
    student = find(state, key)
    if student:
        print(f"already planned: {key} ({student['status']}) -- never fire twice on a key")
        return 1
    state["students"].append({"dispatch_key": key, "test": test, "note": note,
                              "status": "planned", "chat_id": None,
                              "log_path": f"~/.forge/sessions/<chat-id>.jsonl",
                              "planned_at": iso()})
    save(state)
    print(f"planned {key} ({test}) -- fire it now, then record the chat id")
    return 0


def launch(state, key, chat_id):
    student = find(state, key)
    if not student:
        print(f"no planned student {key} -- plan it BEFORE launching")
        return 1
    student["status"] = "launched"
    student["chat_id"] = chat_id
    student["chat_id_full"] = chat_id if len(chat_id) > 12 else None
    student["launched_at"] = iso()
    save(state)
    print(f"launched {key} -> {chat_id}")
    return 0


def verdict(state, key, result, note=""):
    student = find(state, key)
    if not student:
        print(f"no student {key}")
        return 1
    if student["status"] == "verdicted":
        print(f"{key} already verdicted ({student.get('verdict')}) -- replay ignored")
        return 0
    student["status"] = "verdicted"
    student["verdict"] = result
    student["verdict_at"] = iso()
    if note:
        student["note"] = note
    save(state)
    print(f"{key} = {result}")
    return 0


def release(state):
    try:
        os.remove(LOCK)
        print("lock released")
    except OSError:
        print("no lock to release")
    return 0


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    action = sys.argv[1]
    state = load()
    if action == "acquire":
        owner, run, minutes = None, None, DEFAULT_LEASE_MIN
        args = sys.argv[2:]
        for index, arg in enumerate(args):
            if arg == "--owner" and index + 1 < len(args):
                owner = args[index + 1]
            elif arg == "--run" and index + 1 < len(args):
                run = args[index + 1]
            elif arg == "--minutes" and index + 1 < len(args):
                minutes = int(args[index + 1])
        return acquire(state, owner, run, minutes)
    if action == "show":
        return show(state)
    if action == "plan":
        return plan(state, sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
    if action == "launch":
        return launch(state, sys.argv[2], sys.argv[3])
    if action == "verdict":
        return verdict(state, sys.argv[2], sys.argv[3], " ".join(sys.argv[4:]))
    if action == "release":
        return release(state)
    print(f"unknown action {action}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
