// Reads an answer as Claude writes it: the JSON of `{"caption": "...", "marks": [{...}, {...}]}` arrives in
// fragments, and each mark is handed over the moment its closing brace does, so it can be drawn while the rest is
// still being written. It only tracks nesting and strings; whatever it hands over is still parsed and checked.
export class AnswerStream {
  private text = ''
  private at = 0
  private depth = 0
  private inString = false
  private escaped = false
  private stringStart = 0
  private lastString = ''
  private key = ''
  private inMarks = false
  private markStart = 0

  /** Adds a fragment; returns the caption if it just finished, and the marks that did. */
  push(fragment: string): { caption?: string; marks: unknown[] } {
    this.text += fragment
    const found: { caption?: string; marks: unknown[] } = { marks: [] }
    for (; this.at < this.text.length; this.at++) {
      const c = this.text[this.at]
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (c === '\\') this.escaped = true
        else if (c === '"') {
          this.inString = false
          const literal = this.text.slice(this.stringStart, this.at + 1)
          if (this.depth === 1) {
            if (this.key === 'caption') found.caption = parse(literal) as string | undefined
            this.lastString = literal
          }
        }
        continue
      }
      switch (c) {
        case '"':
          this.inString = true
          this.stringStart = this.at
          break
        case ':':
          if (this.depth === 1) this.key = String(parse(this.lastString) ?? '')
          break
        case ',':
          if (this.depth === 1) this.key = ''
          break
        case '{':
        case '[':
          this.depth++
          if (this.depth === 2 && c === '[' && this.key === 'marks') this.inMarks = true
          if (this.inMarks && this.depth === 3 && c === '{') this.markStart = this.at
          break
        case '}':
        case ']':
          if (this.inMarks && this.depth === 3 && c === '}') {
            const mark = parse(this.text.slice(this.markStart, this.at + 1))
            if (mark !== undefined) found.marks.push(mark)
          }
          if (this.inMarks && this.depth === 2 && c === ']') this.inMarks = false
          this.depth--
          break
      }
    }
    return found
  }
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}
