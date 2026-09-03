import type { ReactNode } from 'react'

type SlotComponent<P> = (props: P) => ReactNode

type Framework = { std: string }
type Injected = { menu: number }

type InjectSeat<C, Framework2, I> =
  [C] extends [(props: infer P) => ReactNode]
    ? ([Framework2] extends [P] ? { inject?: () => I } : { inject: () => I })
    : { inject?: () => I }

function registerOld<I extends object = object, C extends SlotComponent<never> = SlotComponent<never>>(
  options: Framework & InjectSeat<C, Framework, I>,
  component: C & ((props: Framework & I) => ReactNode),
): void {}

declare function MenuView(props: Framework & Injected): ReactNode

registerOld({ std: 'x', inject: () => ({ menu: 1 }) }, MenuView)
