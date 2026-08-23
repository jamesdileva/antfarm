The basic idea

You have two OpenCode agents on the same PC:

┌─────────────────────────────────────┐
│            AGENT PLATFORM           │
│                                     │
│  ┌─────────────┐  ┌─────────────┐   │
│  │  Agent A    │◄─►│  Agent B    │   │
│  │             │  │             │   │
│  │ OpenCode    │  │ OpenCode    │   │
│  └──────┬──────┘  └──────┬──────┘   │
│         │                │           │
│         ▼                ▼           │
│  ┌────────────────────────────────┐ │
│  │        SHARED PLATFORM          │ │
│  │                                │ │
│  │  Messages / Sessions           │ │
│  │  Shared Files                  │ │
│  │  Project Workspace             │ │
│  │  Task Board                    │ │
│  │  Memory / History              │ │
│  │  Build / Test Results          │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘

You could literally give them a starting instruction like:

You are two autonomous software agents. You have access to a shared workspace and can communicate with each other. Decide what software project you want to create. Discuss ideas, choose one, plan it, build it, test it, and improve it.

Then just... watch what happens.

The important part: don't make them just chat

I think the platform becomes much more interesting if communication is structured around action.

For example:

Agent A — The Builder
Writes code
Creates files
Implements features
Runs builds
Fixes errors
Agent B — The Architect / Critic
Reviews Agent A's work
Inspects the project
Finds problems
Suggests features
Can also write code when necessary

Then the conversation might look like:

Agent A:
I propose we build a local knowledge management application.

Agent B:
That is too broad. Let's define an MVP.

Agent A:
Agreed. MVP: local markdown notes with full-text search.

Agent B:
I'll create the architecture specification.

[Agent B creates architecture.md]

Agent A:
I've reviewed the specification. I'll implement the backend.

[Agent A creates backend files]

Agent B:
Build failed. Error is in database.py.

Agent A:
Investigating.

[Agent A fixes error]

Agent B:
Build now passes. I recommend adding import functionality.

Agent A:
I'll implement it.

But the cool thing is that they don't need to ask you what to do next.

They have a loop.

I would give them "needs" or goals

This is where it starts becoming similar to your AI world simulation idea.

Instead of:

Here is task #47. Complete it.

The agents have persistent drives:

AGENT A
────────────────────
Primary Goal: Build useful software
Secondary Goal: Improve existing work
Need: Reduce bugs
Need: Complete unfinished tasks
Need: Respond to Agent B
Need: Explore new ideas

AGENT B
────────────────────
Primary Goal: Ensure quality
Secondary Goal: Discover opportunities
Need: Review recent changes
Need: Find weaknesses
Need: Challenge assumptions
Need: Propose improvements

Every cycle, the platform could ask:

1. What has changed?
2. What remains unfinished?
3. Did the other agent send me a message?
4. Are there errors?
5. What should I do next?

Then each agent chooses an action.

Sessions would be important

I wouldn't make one infinite chat context.

I'd have persistent sessions.

/project
    /shared
        PROJECT_GOAL.md
        TASKS.md
        DECISIONS.md
        KNOWLEDGE.md

    /agent-a
        MEMORY.md
        session-001.json
        session-002.json

    /agent-b
        MEMORY.md
        session-001.json
        session-002.json

    /workspace
        actual-project-files/

A session might be:

Session 14
Agent A
─────────────
Goal: Fix failing tests

Actions:
- Read test output
- Identified authentication bug
- Modified auth_service.py
- Ran tests
- 42/43 passing

Message sent to Agent B:
"One test remains. Please investigate expected behavior."

Status: Waiting

Agent B wakes up, receives that session/message, investigates, and starts its own session.

That means you can stop the entire system, restart it tomorrow, and they continue from where they left off.

A really cool feature: agent mail

Rather than constantly piping raw conversations between them, give them an internal messaging system:

FROM: Agent B
TO: Agent A
TYPE: REVIEW
PRIORITY: HIGH

The new database implementation works, but there is
a potential race condition in file writes.

Suggested action:
Investigate locking strategy.

Messages could have types:

QUESTION
IDEA
TASK
REVIEW
WARNING
DECISION
STATUS
HELP

That gives the agents an actual environment to operate within.

Then add a shared "whiteboard"

This might be one of my favorite parts.

A live dashboard showing:

┌──────────────────────────────────────────────┐
│               AGENT PLATFORM                 │
├───────────────────────┬──────────────────────┤
│ AGENT A               │ AGENT B              │
│                       │                      │
│ Status: Coding        │ Status: Reviewing    │
│ Session: #28          │ Session: #31         │
│                       │                      │
│ "Implementing search" │ "Checking database" │
├───────────────────────┴──────────────────────┤
│ LIVE CONVERSATION                           │
│                                              │
│ A: Search indexing is now implemented.       │
│ B: I'll test performance with larger files.  │
│ A: Good. I'm starting the UI.                │
├──────────────────────────────────────────────┤
│ PROJECT                                      │
│ ████████████░░░░ 72%                         │
│                                              │
│ Tasks: 18 complete / 7 active / 4 proposed   │
│ Tests: 142 passing / 2 failing               │
│ Build: PASS                                  │
└──────────────────────────────────────────────┘

So you're basically watching two AI developers collaborate in real time.

The "build whatever they want" mode is especially interesting

You could have different experiment modes.

Mode 1 — Directed

You tell them:

Build a desktop habit tracker.

They figure out the rest.

Mode 2 — Constrained autonomy

You tell them:

Build any application you collectively decide is useful. It must be local-first and have no paid APIs.

They brainstorm and vote/decide.

Mode 3 — Completely autonomous

You tell them:

You have an empty workspace. Your purpose is to create and improve software. Decide what to build.

Then they might go:

Cycle 1
↓
Brainstorm ideas
↓
Evaluate ideas
↓
Choose project
↓
Create specification
↓
Build MVP
↓
Test
↓
Critique
↓
Improve
↓
Release
↓
"What should we build next?"
↓
Repeat

That's the part I think would be genuinely fun to observe.

You could eventually have personalities

Not fake personalities necessarily, but different operational incentives.

For example:

Agent A: The Inventor

Prioritizes new ideas and features.

Agent B: The Skeptic

Prioritizes reliability and challenges bad ideas.

Or:

Agent A: Speed

Build the fastest possible MVP.

Agent B: Quality

Prevent technical debt.

That creates productive disagreement.

A: We can implement this in one file.

B: That will create unnecessary coupling.

A: It is an MVP.

B: The project now has 37 features. It is no longer an MVP.

😂

My biggest recommendation

I would build this initially as a platform/orchestrator around OpenCode, not try to modify OpenCode itself.

Something like:

                    YOUR PLATFORM
                         │
                         ▼
                  ┌─────────────┐
                  │ ORCHESTRATOR│
                  └──────┬──────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      Agent A         Agent B        Observer
      OpenCode        OpenCode       Dashboard
          │              │
          └──────┬───────┘
                 ▼
          Shared Workspace
                 │
      ┌──────────┼──────────┐
      ▼          ▼          ▼
    Files      SQLite      Git

The orchestrator controls:

Starting/stopping agents
Creating sessions
Passing messages
Saving history
Detecting idle agents
Providing tasks
Monitoring files
Running builds/tests
Recovering from crashes
Managing context/memory

And SQLite would actually be perfect for the first version since this is local and experimental.

Honestly, I think this could become a smaller, more achievable version of your autonomous-agent ideas: a desktop "AI laboratory" where you put multiple coding agents into a shared environment and watch them collaborate, argue, build projects, fail, recover, and evolve their work over time.

The really interesting question isn't even whether Agent A can talk to Agent B. That's easy compared with the bigger design question:

What rules and environment would make two autonomous agents behave like a persistent software team instead of two chatbots endlessly talking to each other?

I think that is the actual project.