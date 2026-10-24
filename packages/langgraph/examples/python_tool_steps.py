"""Plain Python producer and checkpoint projection; no B4 Python package required.

Verified with ag-ui-langgraph 0.0.47 / ag-ui-protocol 1.0.0. Compare producer
values with the published @b4run/sdk/tool-step.schema.json v1 schema. This reader
owns known fields, accepts legacy missing-v values, and ignores unknown versions.
"""
from collections import Counter
from datetime import datetime, timezone
from math import isfinite
from re import fullmatch
from time import time
from ag_ui_langgraph import LangGraphAgent
from langchain_core.callbacks.manager import adispatch_custom_event
from langchain_core.messages import ToolMessage


def _epoch_ms(value):
    """Read finite epoch milliseconds or legacy ISO text without float drift."""
    if type(value) is int:
        return value
    if type(value) is float:
        return value if isfinite(value) else None
    if not isinstance(value, str) or not fullmatch(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?", value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        delta = parsed.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        # Date.parse truncates ISO fractional seconds to milliseconds. Integer
        # timedelta arithmetic also avoids binary-float microsecond rounding.
        return delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000
    except (ValueError, OverflowError):
        return None


def project_step(value, tool_call_id=None):
    """Read an owned subset of v1 checkpoint data, omitting carrier identity."""
    if not isinstance(value, dict) or not isinstance(value.get("status"), str) or ("v" in value and (type(value["v"]) is not int or value["v"] != 1)):
        return None
    result = {"v": 1, "kind": value.get("kind") if value.get("kind") in ("server", "provider") else "server"}
    if value.get("status") in ("running", "completed", "failed", "denied", "cancelled"):
        result["status"] = value["status"]
    for key in ("builtin", "provider", "icon", "parentToolCallId"):
        if isinstance(value.get(key), str):
            result[key] = value[key]
    if isinstance(value.get("label"), str) and value["label"].strip():
        result["label"] = value["label"][:120]
    for key in ("startedAt", "settledAt"):
        timestamp = _epoch_ms(value.get(key))
        if timestamp is not None:
            result[key] = timestamp
    if value.get("decision") in ("once", "always", "deny"):
        result["decision"] = value["decision"]
    if isinstance(value.get("queries"), list):
        result["queries"] = [q for q in value["queries"] if isinstance(q, str)]
    if isinstance(value.get("sources"), list):
        result["sources"] = []
        for index, source in enumerate(value["sources"]):
            if not isinstance(source, dict) or not isinstance(source.get("title"), str):
                continue
            owned = {key: source[key] for key in ("id", "title", "href", "snippet", "fileId", "containerId") if isinstance(source.get(key), str)}
            owned.setdefault("id", f"{tool_call_id or 'step'}:{index}")
            owned["kind"] = source.get("kind") if source.get("kind") in ("url", "file", "document", "record") else ("url" if "href" in owned else "record")
            if type(source.get("cited")) is bool:
                owned["cited"] = source["cited"]
            result["sources"].append(owned)
    if result.get("status") == "failed":
        error = value.get("error") if isinstance(value.get("error"), dict) else {}
        message = error.get("message")
        result["error"] = {"message": message if isinstance(message, str) and message.strip() else "Tool call did not finish"}
        if isinstance(error.get("code"), str):
            result["error"]["code"] = error["code"]
    return result


async def lookup_with_steps(config, tool_call_id, lookup):
    """Call an injected async lookup and return its checkpointable ToolMessage.

    Invoke inside an approved graph node/tool and add the returned message to
    graph state. Cancellation/control flow is not converted to completion.
    """
    started = int(time() * 1000)
    running = {"v": 1, "kind": "server", "status": "running", "startedAt": started}
    async def emit(step):
        try:
            await adispatch_custom_event("b4.step", {**step, "toolCallId": tool_call_id}, config=config)
        except Exception:
            pass  # Awaited display transport failures are secondary.
    await emit(running)
    try:
        content = await lookup()
    except Exception as error:
        # LangGraph interrupts must retain control flow, including version-specific
        # GraphBubbleUp subclasses. Do not catch cancellation (BaseException).
        from langgraph.errors import GraphBubbleUp
        if isinstance(error, GraphBubbleUp):
            raise
        content = str(error).strip() or "Tool call did not finish"
        step = {**running, "status": "failed", "settledAt": int(time() * 1000), "error": {"message": content}}
        message = ToolMessage(content=content, tool_call_id=tool_call_id, status="error", additional_kwargs={"b4_step": step})
    else:
        step = {**running, "status": "completed", "settledAt": int(time() * 1000)}
        message = ToolMessage(content=content, tool_call_id=tool_call_id, additional_kwargs={"b4_step": step})
    await emit(step)
    return message


class StepLangGraphAgent(LangGraphAgent):
    """Decorate the public snapshot hook; keep the parent's converter and IDs."""

    async def get_state_and_messages_snapshots(self, config):
        checkpoint = await self.graph.aget_state(config)
        pinned = checkpoint.config
        checkpoint_id = (pinned.get("configurable") or {}).get("checkpoint_id") if pinned else None
        if not isinstance(checkpoint_id, str) or not checkpoint_id:
            raise RuntimeError("A durable checkpoint_id is required for step restore")
        # Pin the parent to this exact checkpoint; never reread moving latest.
        messages = (checkpoint.values or {}).get("messages", [])
        root_namespace = not (pinned.get("configurable") or {}).get("checkpoint_ns")
        roots = [m for m in messages if root_namespace and isinstance(m, ToolMessage) and not getattr(m, "subagent_run_id", None) and not m.additional_kwargs.get("subagent_run_id") and not m.additional_kwargs.get("subagentRunId")]
        counts = Counter(m.tool_call_id for m in roots)
        saved = {m.tool_call_id: m for m in roots if m.tool_call_id and counts[m.tool_call_id] == 1}
        async for event in super().get_state_and_messages_snapshots(pinned):
            if event.type != "MESSAGES_SNAPSHOT":
                yield event
                continue
            projected = []
            event_counts = Counter(m.tool_call_id for m in event.messages if m.role == "tool" and not getattr(m, "subagent_run_id", None))
            for message in event.messages:
                original = saved.get(message.tool_call_id) if message.role == "tool" and not getattr(message, "subagent_run_id", None) and event_counts[message.tool_call_id] == 1 else None
                step = project_step(original.additional_kwargs.get("b4_step"), original.tool_call_id) if original else None
                if step is None:
                    projected.append(message)
                    continue
                updates = {"metadata": {**(message.metadata or {}), "b4.step": step}}
                if step.get("status") == "failed":
                    updates["error"] = step["error"]["message"]
                elif original.status == "error":
                    updates["error"] = original.content if isinstance(original.content, str) and original.content.strip() else "Tool call did not finish"
                projected.append(message.model_copy(update=updates))
            yield event.model_copy(update={"messages": projected})
