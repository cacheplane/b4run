"""Optional real-bridge integration checks; run with the recipe's pinned environment."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch
from ag_ui.core import MessagesSnapshotEvent, ToolMessage as AGUIToolMessage
from ag_ui_langgraph import LangGraphAgent
from langgraph.graph import StateGraph, MessagesState, START, END
from langgraph.checkpoint.memory import InMemorySaver
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from python_tool_steps import StepLangGraphAgent, project_step, lookup_with_steps
from langchain_core.runnables import RunnableLambda
from langchain_core.callbacks import AsyncCallbackHandler
from langgraph.errors import GraphInterrupt


def test_owned_projection():
    original = {"v": 1, "kind": "server", "status": "failed", "sources": [{"id": "a", "kind": "url", "title": "A"}], "unknown": []}
    before = deepcopy(original)

    result = project_step(original)
    result["sources"][0]["title"] = "changed"

    assert original == before
    assert result["error"]["message"] == "Tool call did not finish"
    assert "unknown" not in result
    assert project_step({**original, "v": 2}) is None
    assert project_step({**original, "v": True}) is None
    assert project_step({}) is None
    assert project_step({"status": "future"}) == {"v": 1, "kind": "server"}


def test_legacy_source_ids_are_scoped_to_calls():
    legacy = {"status": "completed", "sources": [{"title": "First"}, {"id": "explicit", "title": "Second"}]}

    first = project_step(legacy, "first-call")
    second = project_step(legacy, "second-call")

    assert first["sources"][0]["id"] == "first-call:0"
    assert second["sources"][0]["id"] == "second-call:0"
    assert first["sources"][1]["id"] == second["sources"][1]["id"] == "explicit"
    assert "id" not in legacy["sources"][0]


async def test_producer():
    events = []
    class Handler(AsyncCallbackHandler):
        async def on_custom_event(self, name, data, **_kwargs):
            events.append((name, deepcopy(data)))
    async def success():
        return "found"
    async def failure():
        raise ValueError("offline")
    async def interrupted():
        raise GraphInterrupt(())
    async def node(_input, config):
        return await lookup_with_steps(config, "call", success)
    runnable = RunnableLambda(node)

    result = await runnable.ainvoke({}, {"callbacks": [Handler()]})
    failed = await lookup_with_steps({}, "failed", failure)
    try:
        await lookup_with_steps({}, "interrupted", interrupted)
        raise AssertionError("interrupt swallowed")
    except GraphInterrupt:
        pass

    assert [value["status"] for name, value in events if name == "b4.step"] == ["running", "completed"]
    assert events[0][1]["toolCallId"] == "call"
    assert "toolCallId" not in result.additional_kwargs["b4_step"]
    assert failed.status == "error"
    assert failed.additional_kwargs["b4_step"]["error"] == {"message": "offline"}


async def test_actual_bridge():
    step = {"v": 1, "kind": "server", "status": "failed", "label": "Lookup failed", "error": {"message": "offline"}}
    def lookup(_state):
        return {"messages": [ToolMessage(id="checkpoint-result", tool_call_id="call", content="offline", status="error", additional_kwargs={"b4_step": step})]}
    graph = StateGraph(MessagesState).add_node("lookup", lookup).add_edge(START, "lookup").add_edge("lookup", END).compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "recipe-test"}}
    await graph.ainvoke({"messages": [HumanMessage(id="user", content="go"), AIMessage(id="assistant", content="", tool_calls=[{"id": "call", "name": "lookup", "args": {}}])]}, config)
    agent = StepLangGraphAgent(name="recipe", graph=graph)
    agent.active_run = {"current_subagent_run_id": None}
    checkpoint = await graph.aget_state(config)
    reads = []
    real_read = graph.aget_state
    async def read(cfg, **kwargs):
        reads.append(deepcopy(cfg))
        if len(reads) == 1:
            # Move latest after reading: parent's second read must stay pinned.
            await graph.aupdate_state(config, {"messages": [ToolMessage(id="checkpoint-result", tool_call_id="call", content="newer", additional_kwargs={"b4_step": {"v": 1, "kind": "server", "status": "completed"}})]})
            return checkpoint
        return await real_read(cfg, **kwargs)

    with patch.object(graph, "aget_state", read):
        events = [event async for event in agent.get_state_and_messages_snapshots(config)]
    message = next(m for e in events if e.type == "MESSAGES_SNAPSHOT" for m in e.messages if m.role == "tool")

    assert reads[1]["configurable"]["checkpoint_id"] == checkpoint.config["configurable"]["checkpoint_id"]
    assert message.id == "checkpoint-result"
    assert message.content == "offline"
    assert message.metadata["b4.step"] == step
    assert message.error == "offline"
    assert checkpoint.values["messages"][-1].additional_kwargs == {"b4_step": step}


async def test_ambiguous_child_unknown_and_parent_fields():
    step = {"v": 1, "kind": "server", "status": "completed"}
    root = ToolMessage(id="raw", tool_call_id="unique", content="ok", additional_kwargs={"b4_step": step})
    duplicate = ToolMessage(id="duplicate", tool_call_id="duplicate", content="ok", additional_kwargs={"b4_step": step})
    unknown = ToolMessage(id="unknown", tool_call_id="unknown", content="ok", additional_kwargs={"b4_step": {**step, "v": 2}})
    state = SimpleNamespace(config={"configurable": {"thread_id": "x", "checkpoint_id": "durable"}}, values={"messages": [root, duplicate, duplicate, unknown]})
    graph = StateGraph(MessagesState).add_node("noop", lambda _: {}).add_edge(START, "noop").add_edge("noop", END).compile(checkpointer=InMemorySaver())
    async def read(_config):
        return state
    graph.aget_state = read
    messages = [AGUIToolMessage(id="parent-remapped", role="tool", tool_call_id="unique", content="ok", metadata={"keep": 1}), AGUIToolMessage(id="child", role="tool", tool_call_id="unique", content="child", subagent_run_id="child"), AGUIToolMessage(id="ambiguous", role="tool", tool_call_id="duplicate", content="ok"), AGUIToolMessage(id="unknown", role="tool", tool_call_id="unknown", content="ok")]
    event = MessagesSnapshotEvent(type="MESSAGES_SNAPSHOT", messages=messages)
    async def parent(_self, cfg):
        assert cfg == state.config
        yield event
    agent = StepLangGraphAgent(name="test", graph=graph)

    with patch.object(LangGraphAgent, "get_state_and_messages_snapshots", parent):
        result = [e async for e in agent.get_state_and_messages_snapshots({})]

    projected = result[0].messages
    assert projected[0].id == "parent-remapped"
    assert projected[0].metadata == {"keep": 1, "b4.step": step}
    assert all(not m.metadata for m in projected[1:])
    assert messages[0].metadata == {"keep": 1}
    state.config = {"configurable": {"thread_id": "x", "checkpoint_id": "durable", "checkpoint_ns": "child:1"}}
    with patch.object(LangGraphAgent, "get_state_and_messages_snapshots", parent):
        child_events = [e async for e in agent.get_state_and_messages_snapshots({})]
    assert child_events[0].messages[0].metadata == {"keep": 1}
    state.config = {"configurable": {"thread_id": "x"}}
    try:
        _ = [e async for e in agent.get_state_and_messages_snapshots({})]
        raise AssertionError("missing checkpoint ID accepted")
    except RuntimeError as error:
        assert "checkpoint_id" in str(error)


if __name__ == "__main__":
    test_owned_projection()
    test_legacy_source_ids_are_scoped_to_calls()
    asyncio.run(test_producer())
    asyncio.run(test_actual_bridge())
    asyncio.run(test_ambiguous_child_unknown_and_parent_fields())
    print("recipe checks passed")
