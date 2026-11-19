"""serve/runconfig.py - #564: the web page's Settings view of the run config (strata-<model>.json).

A short list of documented keys can be read and changed from Strata's own page (GET / POST /config).  Everything
else in the file - the keys setup writes, the network and security keys (host, api_key, cors_origins,
trusted_origins, allowed_hosts), the MCP servers and before_load (which run programs), sampling keys not listed
here - is kept as it is: a change touches only the keys it names (as setup run again keeps the user's keys, #629).
The earlier file is kept as strata-<model>.json.bak.  The server reads the config when it starts, so a change is
used from the next start on.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

# (key, kind, help).  kind: "bool", "int>=0", "num>=0", ("enum", values), "names", or ("sampling", check) for a key
# of the "sampling" block, ("arg", flag) for an engine option kept in "args".
EDITABLE = [
    ("sampling.temperature", ("sampling", "num>=0"),
     "Default temperature for requests that send none (0 = greedy, the default without a sampling block)"),
    ("sampling.top_p", ("sampling", "0<x<=1"), "Default top_p for requests that send none"),
    ("sampling.top_k", ("sampling", "1..64"), "Default top_k for requests that send none (1-64)"),
    ("sampling.min_p", ("sampling", "0<=x<=1"), "Default min_p for requests that send none"),
    ("reasoning_budget_tokens", "int>=0", "Cap the thinking of every request at this many tokens (0 or empty: no cap)"),
    ("fit_max_tokens", "bool", "Shorten a max_tokens that does not fit the context instead of answering 400"),
    ("anthropic_thinking", ("enum", ["model", "on_request"]),
     "Anthropic requests that do not ask for thinking: think as the model does (model) or not (on_request)"),
    ("effort_position", ("enum", ["start", "end"]),
     "Where a non-default reasoning effort goes: start (the default) or end (keeps the cache when it changes)"),
    ("aliases", "names", "Other model names the server lists and answers to (comma-separated)"),
    ("idle_unload_s", "num>=0", "Unload the model after this many seconds without requests (0 or empty: never)"),
    ("lazy_load", "bool", "Start without loading the model; the first request loads it (text only)"),
    ("engine_silence_s", "num>=0", "End a request when the engine says nothing for this long (default 300 s, 0 = wait)"),
    ("api_monitor", "bool", "Keep the last 100 requests' prompts and answers in memory for /api-monitor"),
    ("open_browser", "bool", "Open the chat page in the browser when the model is ready"),
    ("start_beep", "bool", "Ring the terminal's bell when the model is ready (the server's own window)"),
    ("vram_reserve_mib", ("arg", "--vram-reserve-mib"),
     "VRAM in MiB the engine leaves free for other programs (engine default 700)"),
]
SPEC = {k: kind for k, kind, _ in EDITABLE}


def _arg(cfg: dict, flag: str):
    a = cfg.get("args") if isinstance(cfg.get("args"), list) else []
    if flag in a[:-1]:
        v = str(a[a.index(flag) + 1])
        return int(v) if v.isdigit() else v
    return None


def value_of(cfg: dict, key: str):
    kind = SPEC[key]
    if isinstance(kind, tuple) and kind[0] == "sampling":
        s = cfg.get("sampling")
        return s.get(key.split(".", 1)[1]) if isinstance(s, dict) else None
    if isinstance(kind, tuple) and kind[0] == "arg":
        return _arg(cfg, kind[1])
    return cfg.get(key)


def view(cfg: dict, path: str | Path) -> dict:
    """GET /config: the editable keys with their values (None: not set, the default applies)."""
    out = []
    for key, kind, help_ in EDITABLE:
        k = kind[0] if isinstance(kind, tuple) else kind
        out.append({"key": key, "value": value_of(cfg, key), "help": help_,
                    "kind": "number" if k in ("sampling", "arg", "int>=0", "num>=0") else k,
                    **({"choices": kind[1]} if k == "enum" else {})})
    return {"file": Path(path).name, "keys": out,
            "note": "Saved to the run config; used from the next start of the model."}


def _number(key, v, whole=False, lo=0.0, hi=None, lo_open=False):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or (whole and v != int(v)) or \
            (v <= lo if lo_open else v < lo) or (hi is not None and v > hi):
        rng = f"{'more than' if lo_open else 'at least'} {lo:g}" + (f" and at most {hi:g}" if hi is not None else "")
        raise ValueError(f"{key}: expected a {'whole ' if whole else ''}number, {rng}, not {v!r}")
    return int(v) if whole else v


def check(key: str, v, cfg: dict):
    """The value to store for `key`, or a ValueError naming what is expected.  None removes the key (its default)."""
    if key not in SPEC:
        raise ValueError(f"{key!r} cannot be changed here (only the keys the Settings view lists)")
    if v is None:
        return None
    kind = SPEC[key]
    k = kind[0] if isinstance(kind, tuple) else kind
    if k == "bool":
        if not isinstance(v, bool):
            raise ValueError(f"{key}: expected true or false, not {v!r}")
        if key == "lazy_load" and v and cfg.get("vision"):
            raise ValueError("lazy_load: lazy loading is text-only, and this model reads images (\"vision\")")
        return v
    if k == "enum":
        if v not in kind[1]:
            raise ValueError(f"{key}: expected one of {', '.join(kind[1])}, not {v!r}")
        return v
    if k == "names":
        if isinstance(v, str):
            v = [x.strip() for x in v.split(",") if x.strip()]
        if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() and len(x) <= 128 for x in v):
            raise ValueError(f"{key}: expected a list of model names, not {v!r}")
        return v or None
    if k == "int>=0":
        return _number(key, v, whole=True)
    if k == "num>=0":
        return _number(key, v)
    if k == "arg":
        return _number(key, v, whole=True)
    rule = kind[1]                                     # a sampling key: the server's own rules
    if rule == "num>=0":
        return float(_number(key, v))
    if rule == "0<x<=1":
        return float(_number(key, v, hi=1, lo_open=True))
    if rule == "0<=x<=1":
        return float(_number(key, v, hi=1))
    return _number(key, v, whole=True, lo=1, hi=64)


MCP_KEYS = ("mcp_servers", "mcpServers")          # both spellings are read (serve/mcp.py, config_mcp)


def mcp_block(cfg: dict) -> tuple[dict, str | None]:
    """The run config's MCP server block and the key that holds it.  ({}, None) when the config names none -
    servers that came from --mcp-config live in that other file and are not written from here."""
    for k in MCP_KEYS:
        if isinstance(cfg.get(k), dict):
            return cfg[k], k
    return {}, None


def mcp_state(cfg: dict) -> dict:
    """What the config says about every MCP server, INCLUDING the ones it turns off: the hub only ever holds the
    enabled ones, so a disabled server would otherwise leave the page and could never be switched back on.
    {"name": {"disabled": bool, "disabled_tools": [str, ...]}}"""
    block, _ = mcp_block(cfg)
    out = {}
    for name, entry in block.items():
        if not isinstance(entry, dict):
            continue
        out[str(name)] = {"disabled": entry.get("disabled") is True,
                          "disabled_tools": sorted(str(t) for t in (entry.get("disabled_tools") or []))}
    return out


def set_mcp(cfg: dict, changes: list) -> tuple[dict, list[str]]:
    """Turn one MCP server off/on, or one of its tools off/on, in a copy of the config; every other key stays as
    it is.  A change is {"server": name, "disabled": true} or {"server": name, "tool": tool, "enabled": false}.
    Bad or unknown names raise ValueError and nothing is written - the same all-or-nothing rule as apply().
    The tool name is the server's own (what it lists), not the namespaced one the model sees."""
    if not isinstance(changes, list) or not changes:
        raise ValueError('send {"mcp": [{"server": "<name>", "disabled": true}, ...]}')
    _, key = mcp_block(cfg)
    if key is None:
        raise ValueError("this run config names no MCP servers (a --mcp-config file is not written from here)")
    new = json.loads(json.dumps(cfg))
    block = new[key]
    changed: list[str] = []
    for ch in changes:
        if not isinstance(ch, dict):
            raise ValueError("each MCP change must be an object")
        name = str(ch.get("server") or "")
        entry = block.get(name)
        if not isinstance(entry, dict):
            raise ValueError(f"there is no MCP server {name!r} in {key}")
        if "disabled" in ch:
            if not isinstance(ch["disabled"], bool):
                raise ValueError(f"MCP server {name!r}: \"disabled\" must be true or false")
            want = ch["disabled"]
            if (entry.get("disabled") is True) != want:
                entry["disabled"] = want
                changed.append(f"{name} ({'off' if want else 'on'})")
        if ch.get("tool") is not None:
            tool = str(ch["tool"])
            if not isinstance(ch.get("enabled", True), bool):
                raise ValueError(f"MCP tool {name}__{tool}: \"enabled\" must be true or false")
            was = {str(t) for t in (entry.get("disabled_tools") or [])}
            off = set(was)
            if ch.get("enabled", True):
                off.discard(tool)
            else:
                off.add(tool)
            if off != was:
                if off:
                    entry["disabled_tools"] = sorted(off)
                else:
                    entry.pop("disabled_tools", None)
                changed.append(f"{name}__{tool} ({'off' if tool in off else 'on'})")
    if not changed:
        raise ValueError("nothing to change")
    return new, changed


def apply(cfg: dict, changes: dict) -> tuple[dict, list[str]]:
    """The config with `changes` ({key: value or None}) made, and the keys that changed.  Every value is checked
    first, so a request with one bad value changes nothing (ValueError)."""
    if not isinstance(changes, dict) or not changes:
        raise ValueError('send {"set": {"<key>": <value or null>, ...}}')
    checked = {k: check(k, v, cfg) for k, v in changes.items()}
    new = json.loads(json.dumps(cfg))                  # a deep copy: the caller's dict is left alone
    changed = []
    for key, v in checked.items():
        if value_of(new, key) == v:
            continue
        kind = SPEC[key]
        if isinstance(kind, tuple) and kind[0] == "sampling":
            s = dict(new.get("sampling") or {}) if isinstance(new.get("sampling"), dict) else {}
            sub = key.split(".", 1)[1]
            if v is None:
                s.pop(sub, None)
            else:
                s[sub] = v
            if s:
                new["sampling"] = s
            else:
                new.pop("sampling", None)
        elif isinstance(kind, tuple) and kind[0] == "arg":
            a = list(new.get("args") or [])
            flag = kind[1]
            if flag in a[:-1]:
                i = a.index(flag)
                if v is None:
                    del a[i:i + 2]
                else:
                    a[i + 1] = str(v)
            elif v is not None:
                a += [flag, str(v)]
            new["args"] = a
        elif v is None:
            new.pop(key, None)
        else:
            new[key] = v
        changed.append(key)
    return new, changed


def save(path: str | Path, cfg: dict) -> Path:
    """The config written whole (a temporary file moved over the old one), the earlier one kept as <name>.bak."""
    path = Path(path)
    bak = path.with_name(path.name + ".bak")
    shutil.copyfile(path, bak)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    return bak


def load(path: str | Path) -> dict:
    cfg = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(cfg, dict):
        raise ValueError(f"{Path(path).name} is not a JSON object")
    return cfg
