import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { CodeBlock } from '../../../src/markdown/CodeBlock.tsx'
import { ReadBlock } from '../../../src/ReadBlock.tsx'
import { Button } from '../../../src/Button.tsx'
import { readBlockLabels } from '../../labels.client.ts'
import { en } from '../../../../locale/src/locales/en.ts'
import '../../../../web/src/base.css'
import '../../../../ui-theme/src/styles/base.css'
import '../../../../ui-theme/src/styles/shiki.css'
import '../../../../ui-theme/src/styles/design-platform.css'

const recovery = { failed: en['code.highlightFailed'], reload: en['code.reloadPage'] }

function Preview() {
  const [count, setCount] = React.useState(1)
  return (
    <main>
      <h1>Grammar recovery verification</h1>
      <Button onClick={() => { setCount(count + 1) }}>Request updated code</Button>
      <CodeBlock
        code={`print(${count})`} lang="python"
        copyLabel={en.copy} copiedLabel={en.copied} recovery={recovery}
      />
      <ReadBlock
        label="sample.py" lines={[{ number: 1, text: `print(${count})` }]}
        totalLines={1} lang="python"
        labels={{ ...readBlockLabels, copy: en.copy, copied: en.copied, recovery }}
      />
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('Grammar verification page requires a root element')
createRoot(root).render(<Preview />)
