---
name: diagram
description: 'Generate an Excalidraw diagram for the vault. Usage: /learning-loop:diagram "concept or mechanism" or /learning-loop:diagram (infers from context). Produces .excalidraw.md in vault Excalidraw/ folder.'
---

# Diagram — Excalidraw Generation

## Overview

Generate an Excalidraw diagram and save it to the vault. Handles the full pipeline: determine what to diagram, build the JSON, write the file, and optionally embed it in a note.

## When to Use

- `/learning-loop:diagram "concept or mechanism"` -- user specifies what to diagram
- `/learning-loop:diagram` -- infer from conversation context

## Process

### Step 1: Determine What to Diagram

**If args provided:** Use as the concept description.

**If no args:** Read recent conversation. Identify the most diagram-worthy concept -- a mechanism, pathway, feedback loop, multi-step process, or system architecture where relationships between parts matter more than the parts themselves.

**Diagram gate -- check BEFORE proceeding:**
- Does the concept involve 3+ connected components?
- Do arrows/connections carry meaning (causation, flow, dependency)?
- Would prose obscure the relationships?

If the answer to all three is no, tell the user: "This works better as text/table -- no diagram needed." and stop.

### Step 2: Load Diagram Rules

Read the diagram-rules agent file to get the full Excalidraw construction spec:

```
{{PLUGIN}}/agents/diagram-rules.md
```

Follow every rule in that file. Key points:
- `.excalidraw.md` format with empty `## Text Elements` section
- Soft fill colors: `#a5d8ff` (blue), `#b2f2bb` (green), `#ffec99` (yellow), `#ffc9c9` (red), `#d0bfff` (purple)
- `fontFamily: 5`, `roughness: 1`
- Descriptive string IDs, random seed integers
- Do NOT include `frameId`, `index`, `versionNonce`, or `rawText` fields
- Text width: ~10px/char at 16, ~13px/char at 20, ~16px/char at 28
- Container width = text width + 60px padding
- 30px minimum gap between element edges
- 4-8 core elements. If more than 15, split or simplify.

### Step 3: Plan the Layout

Before writing JSON, plan on paper:

1. **Identify elements:** List the 4-8 core components
2. **Identify connections:** What arrows connect what? Solid (direct) or dashed (indirect)?
3. **Choose pattern:** Fan-out, convergence, timeline, cycle, assembly line, or diamond decision
4. **Choose layout direction:** Left-to-right for sequences, top-to-bottom for hierarchies
5. **Calculate positions:** Space elements 200px apart minimum, 30px gap between edges

### Step 4: Generate and Write

Build the full Excalidraw JSON following diagram-rules exactly. Write to:

```
{{VAULT}}/Excalidraw/{slug}.excalidraw.md
```

Where `{slug}` is a descriptive kebab-case name (e.g., `thalen-engagement-loop-tiers`).

**File format:**
```markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==&#x26a0;  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. &#x26a0;== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
%%
## Drawing
```json
{JSON here}
```
%%
```

### Step 5: Validate

Check the generated JSON:
1. No overlapping positions (30px minimum between edges)
2. Container text fits (text width < container width - 60px)
3. Arrow first point is `[0, 0]`, width/height match point bounding box
4. All IDs unique
5. No `frameId`, `index`, `versionNonce`, or `rawText` fields present

### Step 6: Report

```
Diagram: "{title}" -> Excalidraw/{slug}.excalidraw.md
Embed with: ![[{slug}]]
```

If the conversation has an obvious note to embed it in, suggest which note. Otherwise just report the path.

## Key Principles

- **Connections carry meaning.** If you remove the arrows and it still works, it was a layout, not a diagram.
- **Focused scope.** One mechanism per diagram. Split complex systems.
- **Follow diagram-rules exactly.** Read the agent file every time. Don't rely on memory.
- **No extra elements.** Default to free-floating text. Only add containers when the shape itself carries meaning.
- **Calculate widths.** Never hardcode text widths. Compute from character count every time.
