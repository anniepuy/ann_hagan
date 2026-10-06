---
title: "Dog Walk Agent"
summary: "A local-first AI agent that reasons over live weather, air quality, and daylight to decide whether — and how long — to walk the dog."
github: "https://github.com/anniepuy/dog_walk_agent"
order: 1
---

_Should I walk the dog right now?_ Dog Walk Agent answers it the way a thoughtful
person would — by checking the actual conditions and weighing them. Give it your
city and it resolves your coordinates, pulls **live weather, air quality, and
sunrise/sunset times**, then returns a structured verdict — `WALK`, `SHORT_WALK`,
`WAIT`, or `SKIP` — with the reasons and risks spelled out.

Under the hood it's a tool-calling agent (built on `picoagents`) running entirely on
a **local LLM via Ollama** — no cloud, no API keys. It picks which tools to call,
remembers stable facts between turns, and returns a typed `WalkDecision` object
instead of prose, so the output is something another program could act on.

An experiment in **applied reasoning**: turning a handful of live data feeds into a
concrete, explainable decision.
