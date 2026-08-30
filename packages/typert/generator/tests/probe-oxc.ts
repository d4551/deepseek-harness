/** Scratch: does oxc-transform lower a standard decorator with the plugin's exact options? */
import { transformSync } from 'oxc-transform'

const source = `function Deco(target: unknown, ctx: unknown): void { void target; void ctx }
class Service {
  @Deco
  method(): number { return 1 }
}
export { Service }
`
const result = transformSync('probe.ts', source, {
  sourcemap: true,
  decorator: { legacy: false },
  target: 'es2024',
})
process.stdout.write(`errors=${JSON.stringify(result.errors)}\n`)
process.stdout.write(`hasRawDecorator=${String(/^\s*@Deco/m.test(result.code))}\n`)
process.stdout.write(`---\n${result.code.slice(0, 400)}\n`)
