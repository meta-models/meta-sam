# API Playground design exploration

## Product constraints

The playground is an evidence viewer, not a marketing page. It must give the source media, cumulative parser output, diagnostics, and transport state a clear visual hierarchy in both light and dark themes. Replay is the deterministic default. Live requests cross a same-origin server boundary and never put credentials in browser state, URLs, logs, or controls.

## Direction A — editorial instrument bench (selected)

A media-first, asymmetric 70/30 workbench: one large evidence stage beside a narrower controls and records rail. Neutral graphite surfaces keep the interface quiet while the renderer owns segmentation color. Compact mono telemetry distinguishes machine evidence from labels and actions. Dividers, alignment, and whitespace create hierarchy instead of repeated floating cards.

This direction is selected because the application must work equally well in light and dark themes and foreground inspectable evidence. The large stage makes image and video composition and overlay correctness primary, while the rail keeps prompt, run state, object visibility, diagnostics, and raw protocol output close without competing with the media. Video keeps this same editorial workbench rather than switching to a cinematic treatment; packet-exact controls, player telemetry, captures, and audio state remain inspectable Astryx controls.

## Direction B — cinematic screening room

A dark, immersive stage with controls receding into the edges and output appearing as an overlay. This would make video feel dramatic, but it biases the product toward dark mode, weakens diagnostics and tabular evidence, and makes the image workflow feel like a subordinate mode.

## Direction C — lab notebook

A paper-grid canvas with tabular evidence, margin annotations, and a stronger document metaphor. This would support forensic reading, but the grid competes with masks and boxes, and the notebook treatment becomes visually fragile in dark mode.

## Visual system

- Astryx components and tokens provide all interactive controls and UI surfaces. The header can switch among the Neutral, Stone, Gothic, Matcha, Y2K, and Butter visual themes while preserving the independent light/dark/system color mode.
- The exact Astryx frame is `AppShellContentOnly`: `AppShell` owns the main landmark and contains one `Layout` with a fixed `LayoutHeader`/`Toolbar`, a `LayoutContent` media stage, and a 380 px end `LayoutPanel` for request and evidence controls.
- `useMediaQuery` deliberately moves the `LayoutPanel` below `LayoutContent` on narrow screens without changing the stage-first DOM order.
- `Section` groups page regions; the request rail orders Model, Media, and noun-phrase actions before run status. The model control is an Astryx `Typeahead`, and request code opens in an Astryx `Dialog` with curl and TypeScript tabs. `List`/`ListItem` render structured evidence; `EmptyState` explains zero-data states. Custom CSS is reserved for the media canvas/player, code overflow, and raw protocol output.
- No gradients, oversized hero treatment, emojis, or repeated card containers.
- The object controls use stable ordinals and object identifiers without claiming to reproduce the renderer's private palette.
- Default state is deterministic Replay with an example staged but not executed.
