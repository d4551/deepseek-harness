/**
 * The explicit-stack driver both SDK schema renderers walk with. A JSON schema
 * nests arbitrarily deep, so neither renderer may recurse: the stack lives on
 * the heap and each frame is visited twice — once to schedule its children,
 * once to combine their results — which keeps rendering linear in schema size
 * and immune to a deep schema overflowing the call stack.
 * @module @deepseek-ai/dsh-tools/src/schema-render-stack
 */

/**
 * The scheduling state one driven frame holds. A renderer's own frame adds
 * whatever its combine step reads.
 *
 * @typeParam Child - what the renderer schedules for each nested schema.
 * @typeParam Result - what rendering one node produces.
 */
export interface SchemaRenderFrameBase<Child, Result> {
  /** `start` until the driver schedules the frame's children, `children` after. */
  phase: 'start' | 'children'
  /** Nested schemas the start step scheduled, in emission order. */
  children: Child[]
  /** How many scheduled children already have results. */
  childIndex: number
  /** Results of the scheduled children, in the same order. */
  childResults: Result[]
}

/** Any renderer's frame, as the driver reads it. */
type AnyRenderFrame = SchemaRenderFrameBase<unknown, unknown>

/** What one renderer schedules for a nested schema. */
type ChildOf<Frame extends AnyRenderFrame> = Frame['children'][number]

/** What one renderer produces for a single schema node. */
type ResultOf<Frame extends AnyRenderFrame> = Frame['childResults'][number]

/** The steps one renderer supplies to {@link renderSchemaStack}. */
export interface SchemaRenderSteps<Frame extends AnyRenderFrame> {
  /**
   * Build the frame for one scheduled child.
   * @param child - the child its parent's start step scheduled.
   * @returns a fresh frame in `start` phase.
   */
  frame(child: ChildOf<Frame>): Frame
  /**
   * Handle one frame's node: either schedule its children into
   * `frame.children` or finish the frame with its result.
   * @param frame - the frame being visited for the first time.
   * @param finish - completes this frame with its rendered result.
   */
  start(frame: Frame, finish: (result: ResultOf<Frame>) => void): void
  /**
   * Combine a frame's child results into its own. Called once every scheduled
   * child has finished, so `frame.childResults` matches `frame.children`.
   * @param frame - the frame whose children are all rendered.
   * @param finish - completes this frame with its rendered result.
   */
  combine(frame: Frame, finish: (result: ResultOf<Frame>) => void): void
}

/**
 * Drive one schema walk to the root's result.
 * @param root - the root frame, in `start` phase.
 * @param steps - the renderer's frame, start, and combine steps.
 * @returns the root's result, or undefined when the root never finished.
 */
export function renderSchemaStack<Frame extends AnyRenderFrame>(
  root: Frame,
  steps: SchemaRenderSteps<Frame>,
): ResultOf<Frame> | undefined {
  const frames: Frame[] = [root]
  let rootResult: ResultOf<Frame> | undefined
  const finish = (result: ResultOf<Frame>): void => {
    frames.pop()
    const parent = frames.at(-1)
    if (parent === undefined) rootResult = result
    else parent.childResults.push(result)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    if (frame.phase === 'children') {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]
        /* v8 ignore next -- childIndex is bounded by children.length. */
        if (child === undefined) throw new Error('missing schema render child')
        frame.childIndex++
        frames.push(steps.frame(child))
        continue
      }
      steps.combine(frame, finish)
      continue
    }
    frame.phase = 'children'
    steps.start(frame, finish)
  }
  return rootResult
}
