---
description: Shared rules for when and how to generate Excalidraw diagrams during research tasks. Referenced by discovery-researcher and note-writer agents.
---

# Diagram Generation Rules

## When to Diagram

Generate a diagram when the insight involves a **mechanism, pathway, or multi-step process where the relationships between parts matter more than the parts themselves.**

**Diagram when:**
- A feedback loop connects 3+ components (e.g., glutamate → inflammation → glia → glutamate)
- A pathway branches or converges (e.g., kynurenine pathway splitting into neuroprotective vs neurotoxic arms)
- A multi-step process has dependencies or ordering that prose obscures (e.g., transporter gates, metabolic sequences)
- Cause-and-effect chains span multiple layers (e.g., gut → blood → brain barrier crossings)

**Do NOT diagram:**
- Simple factual claims (theanine has 65-75% bioavailability)
- Lists or comparisons that work fine as tables
- **Taxonomies and classifications** — "X belongs to category Y" is a table, not a diagram. If nothing connects to anything else, it's not a diagram.
- Single cause-effect pairs (A causes B — just say it)
- Anything where a sentence does the job

**The test:** If you removed all the arrows and the diagram still "works," it was never a diagram — it was a layout. Diagrams derive meaning from connections, not positions.

## Where to Save

Write diagrams to `{{VAULT}}/Excalidraw/` with a descriptive filename:
```
{{VAULT}}/Excalidraw/{insight-slug}.excalidraw.md
```

The accompanying vault note embeds the diagram:
```markdown
![[{insight-slug}]]
```

## File Format

Use the `.excalidraw.md` format. The `## Text Elements` section is **left empty** — the Obsidian Excalidraw plugin auto-fills it from the JSON data.

```markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
%%
## Drawing
```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://github.com/zsviczian/obsidian-excalidraw-plugin",
  "elements": [...],
  "appState": {
    "gridSize": null,
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```
%%
```

## Visual Style

Keep diagrams clean and readable:

- **Colors:** Use soft fills — `#a5d8ff` (blue), `#b2f2bb` (green), `#ffec99` (yellow), `#ffc9c9` (red), `#d0bfff` (purple). Stroke color `#1e1e1e`.
- **Shapes:** Rectangles for processes/states, ellipses for start/end points, diamonds for decisions/branches.
- **Text:** `fontSize: 20` for labels in containers, `fontSize: 16` for free-floating labels and annotations. `fontFamily: 5` (Excalifont).
- **Arrows:** Solid for direct causation, dashed (`strokeStyle: "dashed"`) for indirect/modulatory effects.
- **Layout:** Left-to-right for sequences, top-to-bottom for hierarchies. Space elements 200px apart minimum.
- **Roughness:** `1` for the hand-drawn aesthetic.
- **Rounded corners:** `{ "type": 3 }` on rectangles.

### Container Discipline

Not every piece of text needs a shape around it. Default to free-floating text. Add containers only when the element represents a distinct "thing" in the system, needs arrows connecting to it, or the shape itself carries meaning (decision diamond, etc.).

Use font size and color to create visual hierarchy without boxes. A 20px title doesn't need a rectangle around it.

## Element Construction

### Required Fields

Every element needs these fields. **Do NOT include** `frameId`, `index`, `versionNonce`, or `rawText` — they cause issues.

```json
{
  "id": "descriptive-id",
  "type": "rectangle",
  "x": 100, "y": 100,
  "width": 200, "height": 80,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#a5d8ff",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "roundness": {"type": 3},
  "seed": 123456,
  "version": 1,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1,
  "link": null,
  "locked": false
}
```

### Text in Containers

Text element needs `containerId` pointing to parent shape. Parent shape needs `{"type": "text", "id": "textId"}` in its `boundElements` array. **One text element per container — never two.** If you need a header + subtitle, combine into a single text element with `\n` line breaks.

```json
{
  "id": "rect1",
  "type": "rectangle",
  "boundElements": [{"id": "txt1", "type": "text"}],
  ...
}
```
```json
{
  "id": "txt1",
  "type": "text",
  "text": "Process Step",
  "originalText": "Process Step",
  "autoResize": true,
  "fontSize": 20,
  "fontFamily": 5,
  "textAlign": "center",
  "verticalAlign": "middle",
  "containerId": "rect1",
  "lineHeight": 1.25,
  "boundElements": null,
  ...
}
```

### Free-Floating Text

For labels, annotations, and titles that don't need a container:

```json
{
  "id": "label1",
  "type": "text",
  "text": "Section Title",
  "originalText": "Section Title",
  "autoResize": true,
  "fontSize": 16,
  "fontFamily": 5,
  "textAlign": "left",
  "verticalAlign": "top",
  "containerId": null,
  "lineHeight": 1.25,
  "boundElements": null,
  ...
}
```

### Arrows

Arrows use `startBinding`/`endBinding` to connect to shapes. The shapes they connect to do NOT need the arrow in their `boundElements` — only text bindings go there.

```json
{
  "id": "arrow1",
  "type": "arrow",
  "points": [[0, 0], [146, 0]],
  "startBinding": {"elementId": "rect1", "focus": 0, "gap": 2},
  "endBinding": {"elementId": "rect2", "focus": 0, "gap": 2},
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "boundElements": null,
  ...
}
```

Arrow `points` are relative to the arrow's `x,y`. First point is always `[0, 0]`. Arrow `width`/`height` should match the bounding box of the points array.

### IDs

Use descriptive string IDs (e.g., `"rect_dmn"`, `"arrow_suppress"`, `"txt_title"`). Must be unique across all elements.

### Seeds

Use random integers for `seed`. No `versionNonce` needed.

## Text Width Estimation

Excalifont (fontFamily 5) is wide and irregular. Use these estimates to size containers:

| fontSize | px per character | notes |
|----------|-----------------|-------|
| 16 | ~10px | annotations, labels |
| 20 | ~13px | container text |
| 28 | ~16px | titles |

```
textWidth = text.length * pxPerChar
containerWidth = textWidth + 60  (30px padding each side)
```

**Spacing between adjacent elements:** minimum 30px gap between edges (not centers).

**Never hardcode text widths from memory.** Calculate from the actual text string each time.

## Post-Generation Validation

With the empty Text Elements approach, most validation is eliminated. Check only:

1. **No overlapping positions:** No two elements share the same x,y coordinates. Minimum 30px separation between element edges.
2. **Container text fits:** For text inside rectangles, verify text width < container width - 60px. If too wide, widen the container.
3. **Arrow points valid:** First point is `[0, 0]`, `width`/`height` match point bounding box.
4. **All IDs unique:** No duplicate IDs across elements.

## Visual Patterns

Choose pattern based on what the concept does:

| If the concept... | Use this pattern |
|-------------------|------------------|
| Spawns multiple outputs | **Fan-out** (radial arrows from center) |
| Combines inputs into one | **Convergence** (arrows merging) |
| Is a sequence of steps | **Timeline** (line + dots + free-floating labels) |
| Loops or improves continuously | **Cycle** (arrow returning to start) |
| Transforms input to output | **Assembly line** (before → process → after) |
| Branches at a condition | **Diamond decision** with diverging arrows |

## Scope

Keep diagrams focused on one mechanism. A diagram with 15+ elements is too complex — split into multiple diagrams or simplify. Aim for 4-8 core elements with connecting arrows.
