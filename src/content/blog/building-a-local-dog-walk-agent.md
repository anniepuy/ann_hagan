---
title: "Building a dog-walking agent that runs on my own machine"
description: "Why I gave a local LLM tools, a structured output schema, and a very specific job: deciding when to walk the dog."
pubDate: 2026-10-05
tags: ["agents", "local-llm", "applied-reasoning"]
---

I wanted a small, honest test of "agentic" AI — something with a real decision at the
end, not a chatbot that trails off. So I built an agent that answers one question:
**should I walk the dog right now?**

## Make it decide, not chat

The first choice that mattered was the _output_. It would've been easy to let the
model ramble a paragraph of weather vibes. Instead I gave it a schema — a Pydantic
`WalkDecision` with a `recommendation` (`WALK`, `SHORT_WALK`, `WAIT`, `SKIP`), an
optional duration, and explicit `reasons` and `risks`. Forcing structure did two
things: it made the answer _actionable_ (a program could consume it), and it quietly
made the model reason better — you can't fill in `risks: []` honestly without
actually checking the conditions.

## Give it tools, not trivia

The model doesn't know the weather in Atlanta, and it shouldn't pretend to. So it gets
tools: geocode a city, fetch live weather and air quality (Open-Meteo), look up the
daylight window, check the time. The agent decides which ones it needs for a given
question — ask a simple question and it skips the API calls; ask about _now_ and it
goes and gets the real numbers. That orchestration is the actually-interesting part:
the model as a planner, the tools as its hands.

## Keep it local

I ran the whole thing on a local LLM through Ollama — no cloud endpoint, no API key,
nothing leaving the machine. Partly privacy, partly cost, partly because I wanted to
know how far a capable local model could get on a genuinely multi-step task. The
answer: further than I expected. Tool-use and structured output both held up.

## What I'd do next

The memory is currently in-process, so it forgets between runs — persisting facts to
disk is the obvious next step, and it's where this stops being a demo and starts being
_mine_. A small CLI instead of a hardcoded prompt would help too.

But the core lesson stuck: a clear decision, a strict output shape, and a handful of
real tools turn "an LLM" into something that feels a lot more like an engineer's
instrument than a toy.

## Project notes

This project is based off the principals from Victor Dibia's "Designing Multi-Agent Systems", 2025.
