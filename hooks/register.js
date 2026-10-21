// Quick prompts: after each finished turn, show four follow-up prompts in the
// band above the prompt. Type 1-4 into an empty prompt (and pause) to put one in
// the prompt box, then press Enter to send it or edit it first. `/qp N` sends at once.
//
// Modes (`/qp <mode>`, remembered across sessions):
//   smart  a side request suggests four follow-ups from the last exchange
//   learn  the same, but the suggestions deepen understanding (why, what-if, quiz)
//   fixed  no model call: four prompts picked from what the turn did
//   off    nothing
//
// Models for smart and learn (`/qp model <model>`, remembered across sessions):
//   haiku    Haiku reads the last exchange and a summary of the turn: fast, cheap
//   session  a fork of the whole conversation on the session's model: sees every
//            earlier turn, but resends the session's full context each time

const MODES = ['smart', 'learn', 'fixed', 'off']
const MODELS = ['haiku', 'session']
const ANSWER_MAX = 6000
const REQUEST_TIMEOUT_MS = 30000
const MAX_LEN = 70

const PROMPTS = {
  smart: `You suggest the user's next message in this coding-agent conversation.
Write exactly 4 short follow-up prompts the USER would plausibly send next, based on the last exchange.
Make them concrete and different from each other: e.g. continue the work, verify or test it, dig into a detail, change direction.
If the assistant asked the user a question, the first suggestion answers it.
Each under ${MAX_LEN} characters, imperative, no numbering, no quotes.
Reply with only a JSON array of 4 strings.`,
  learn: `You coach a software engineer who wants to understand, not just finish, the work in this conversation.
Write exactly 4 short prompts the USER could send next to deepen their understanding of the last exchange:
one "why does this work" question, one "what would happen if" question, one asking for the general concept or system picture,
and one "quiz me on this" request. Name the specific thing (file, service, error, command) in each.
Each under ${MAX_LEN} characters, no numbering, no quotes.
Reply with only a JSON array of 4 strings.`,
}

let mode = 'smart'
let model = 'haiku'
let userText = ''
let prompts = []
let status = 'idle' // 'idle' | 'thinking' | 'shown'
let label = ''
let generation = 0
let turn = { tools: [], edited: false, failed: false }

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function fixedPrompts(t) {
  const out = []
  if (t.asked) out.push('Yes, go ahead', 'No, keep it as is')
  if (t.failed) out.push('Why did that fail? Fix it')
  if (t.edited) out.push('Run the tests and smoke-check it', 'Review the diff for bugs')
  out.push('Explain that more simply', 'Continue', 'Learn mode, retro: what should I take from this?', 'Retro: what could we do better?')
  return [...new Set(out)].slice(0, 4)
}

export function parseSuggestions(reply) {
  let items = []
  const json = reply.match(/\[[\s\S]*\]/)
  if (json) {
    try {
      items = JSON.parse(json[0])
    } catch {}
  }
  if (!items.length) items = reply.split('\n')
  return items
    .filter((s) => typeof s === 'string')
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'`]|["'`,]$/g, '').trim())
    .filter((s) => s.length > 0)
    .slice(0, 4)
}

const endsWithQuestion = (text) => /\?\s*\**\s*$/.test(text.trim().split('\n').slice(-3).join(' '))

function render($, nextStatus, nextLabel) {
  status = nextStatus
  label = nextLabel
  $.ui.invalidate('ui.render')
}

async function clear($) {
  generation++
  prompts = []
  await render($, 'idle', '')
}

async function suggest($, t) {
  const ticket = ++generation
  const current = mode
  const source = model
  if (current === 'fixed') {
    prompts = fixedPrompts(t)
    return render($, 'shown', 'fixed')
  }
  prompts = []
  render($, 'thinking', `${current} · ${source}`)
  const r = await within($, () => request($, current, source, t), REQUEST_TIMEOUT_MS)
  if (ticket !== generation) return
  const parsed = r.isAnswered ? parseSuggestions(r.text) : []
  prompts = parsed.length ? parsed : fixedPrompts(t)
  const why = r.isAnswered ? 'unparsed' : r.reason
  if (!parsed.length) $.ui.log(`qp: ${current} (${source}) fell back to fixed prompts: ${why}`, { to: 'debug' })
  render($, 'shown', parsed.length ? `${current} · ${source}` : `${current} · ${source} failed (${why}), fixed`)
}

const tail = (s) => (s.length > ANSWER_MAX ? '…' + s.slice(-ANSWER_MAX) : s)

function turnSummary(t) {
  const counts = {}
  for (const name of t.tools) counts[name] = (counts[name] ?? 0) + 1
  const tools = Object.entries(counts).map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
  const notes = [tools.length ? `tools used: ${tools.join(', ')}` : 'no tools used']
  if (t.edited) notes.push('files were edited')
  if (t.failed) notes.push('a tool call failed')
  return notes.join('; ')
}

function request($, current, source, t) {
  if (source === 'session') {
    // The fork replays the main thread's last request, which ends before this turn's
    // final answer, so hand the answer over explicitly (its tail matters most).
    const prompt = `The assistant's final reply this turn was:\n<reply>\n${tail(t.answer)}\n</reply>\n\n${PROMPTS[current]}`
    return $.model.fork({ prompt })
  }
  const exchange = `<user>\n${tail(t.userText)}\n</user>\n<assistant>\n${tail(t.answer)}\n</assistant>\n<turn>${turnSummary(t)}</turn>`
  return $.model.complete({ model: 'haiku', system: PROMPTS[current], prompt: exchange, maxTokens: 300 })
}

// $.model.fork takes no time limit, and a rejected call would leave the band on
// "thinking…" for good, so bound every request and turn a rejection into a reason.
async function within($, call, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = $.clock.after(ms, () => resolve({ isAnswered: false, reason: 'timed out' }))
  })
  try {
    return await Promise.race([call(), timeout])
  } catch (error) {
    return { isAnswered: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    timer?.cancel()
  }
}

async function pick($, n, send) {
  const prompt = prompts[n - 1]
  if (!prompt) return { text: `No quick prompt ${n}` }
  if (send) {
    await clear($)
    // Resolves when the turn starts, so don't hold the command on it.
    void $.prompt.submit({ text: prompt, asUser: true })
  } else {
    await $.prompt.fill({ text: prompt })
  }
  return {}
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('mode')
    if (MODES.includes(saved)) mode = saved
    const savedModel = await $.store.get('model')
    if (MODELS.includes(savedModel)) model = savedModel
    await $.command.register({
      name: 'qp',
      description: 'Quick prompts: /qp [smart|learn|fixed|off|model haiku|model session|1-4|edit N]',
      argumentHint: '[smart|learn|fixed|off|model haiku|model session|1-4|edit N]',
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await clear($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turn = { tools: [], edited: false, failed: false }
    userText = e.text
    await clear($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const result = await next(e)
    turn.tools.push(e.tool)
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool)) turn.edited = true
    if (result && (result.isError || result.deny)) turn.failed = true
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || mode === 'off' || e.isAborted || e.reason !== 'answer') return next(e)
    if (!e.answer.trim()) return next(e)
    const t = { ...turn, userText, answer: e.answer, asked: endsWithQuestion(e.answer) }
    // Don't hold the turn's end on the side request.
    void suggest($, t)
    return next(e)
  })

  on('command.run', { command: 'qp' }, async ($, e) => {
    const [verb, arg] = (e.args || '').trim().split(/\s+/)
    if (!verb) {
      return { text: `Quick prompts: ${mode} · model ${model}${prompts.length ? ` · ${prompts.length} shown` : ''}` }
    }
    if (MODES.includes(verb)) {
      mode = verb
      await $.store.set('mode', mode)
      await clear($)
      return { text: `Quick prompts: ${mode}` }
    }
    if (verb === 'model') {
      if (!arg) return { text: `Quick prompts model: ${model}` }
      if (!MODELS.includes(arg)) return { text: 'Usage: /qp model [haiku|session]' }
      model = arg
      await $.store.set('model', model)
      await clear($)
      return { text: `Quick prompts model: ${model}` }
    }
    if (/^[1-4]$/.test(verb)) return pick($, Number(verb), true)
    if (verb === 'edit' && /^[1-4]$/.test(arg ?? '')) return pick($, Number(arg), false)
    return { text: 'Usage: /qp [smart|learn|fixed|off|model haiku|model session|1-4|edit N]' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (mode === 'off' || status === 'idle' || e.props.hasSurvey) return theirs
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns

    const header = Text({
      dimColor: true,
      wrap: 'truncate-end',
      children: [
        status === 'thinking'
          ? `quick prompts · ${label} · thinking…`
          : `quick prompts · ${label}   (type 1-4 to pick · Enter to send · /qp off)`,
      ],
    })

    if (status === 'thinking') return Box({ flexDirection: 'column', children: [theirs, header].filter(Boolean) })

    // A bare digit fires only for buttons wholly inside the band's window, so all
    // four must fit: drop the header, then pack the prompts into columns.
    const fullRows = prompts.length + 1
    const showHeader = e.props.maxRows >= fullRows
    const rowsFree = Math.max(1, showHeader ? e.props.maxRows - 1 : e.props.maxRows)
    const cols = Math.ceil(prompts.length / Math.min(rowsFree, prompts.length))
    const cell = Math.max(10, Math.min(MAX_LEN, Math.floor(width / cols) - 5))

    const button = (p, i) =>
      Button({
        key: 'qp-send-' + i,
        label: clip(p, cell),
        hotkey: String(i + 1),
        plain: true,
        onPress: async () => {
          await pick($, i + 1, false)
        },
      })

    const lines = []
    for (let i = 0; i < prompts.length; i += cols) {
      lines.push(
        Box({
          key: 'qp-line-' + i,
          flexDirection: 'row',
          columnGap: 2,
          children: prompts.slice(i, i + cols).map((p, j) => button(p, i + j)),
        }),
      )
    }

    return Box({ flexDirection: 'column', children: [theirs, showHeader && header, ...lines].filter(Boolean) })
  })
}
