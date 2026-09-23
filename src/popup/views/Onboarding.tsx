import { useState } from 'react'
import { createWallet, restoreFromMnemonic } from '../../lib/bridge'
import { sendToBackground, WalletSecrets } from '../../lib/messages'

/** Cheap length + character-class heuristic — deliberately no zxcvbn-style dependency. */
function passwordStrength(pw: string): { label: string; color: string; pct: number } | null {
  if (!pw) return null
  let classes = 0
  if (/[a-z]/.test(pw)) classes++
  if (/[A-Z]/.test(pw)) classes++
  if (/[0-9]/.test(pw)) classes++
  if (/[^a-zA-Z0-9]/.test(pw)) classes++
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (pw.length >= 16) score++
  score += classes >= 3 ? 2 : classes >= 2 ? 1 : 0
  if (score <= 1) return { label: 'weak', color: 'var(--red)', pct: 33 }
  if (score <= 3) return { label: 'fair', color: '#f5a623', pct: 66 }
  return { label: 'strong', color: 'var(--green)', pct: 100 }
}

function StrengthHint({ password }: { password: string }) {
  const s = passwordStrength(password)
  if (!s) return null
  return (
    <div style={{ marginTop: -6, marginBottom: 10 }}>
      <div style={{ height: 3, background: '#1c1c1c' }}>
        <div style={{ height: '100%', width: `${s.pct}%`, background: s.color, transition: 'width 0.2s, background 0.2s' }} />
      </div>
      <span style={{ fontSize: 10, color: s.color }}>{s.label}</span>
      {s.label !== 'strong' && (
        // The vault can be brute-forced OFFLINE by anything that can
        // read the browser profile — password strength is the real defense.
        <div style={{ fontSize: 10, color: 'var(--dim, #888)', marginTop: 2 }}>
          This password protects your funds even if your computer's files are
          stolen — a long passphrase (e.g. 4+ random words) is much stronger.
        </div>
      )}
    </div>
  )
}

export function Onboarding({ onDone, addMode = false, onCancel }:
  { onDone: () => void; addMode?: boolean; onCancel?: () => void }) {
  const [mode, setMode] = useState<'menu' | 'create' | 'confirm' | 'restore'>('menu')
  // seed confirmation quiz: 5 random word positions; their words are shown
  // shuffled and must be tapped back in position order
  const [quizIdx, setQuizIdx] = useState<number[]>([])
  const [quizChoices, setQuizChoices] = useState<string[]>([])
  const [quizPicked, setQuizPicked] = useState<number[]>([]) // indices into quizChoices, in tap order
  const [mnemonic, setMnemonic] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pending, setPending] = useState<WalletSecrets | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (secrets: WalletSecrets) => {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    const r = await sendToBackground({ type: 'SAVE_WALLET', secrets, password, name: name.trim() || undefined })
    if (r.ok) onDone()
    else setError(r.error)
  }

  /** Move from seed display to the confirmation quiz: 5 random distinct word positions. */
  const startQuiz = () => {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirmPassword) { setError('Passwords do not match'); return }
    if (!pending) return
    setError('')
    const words = pending.mnemonic.trim().split(/\s+/)
    const positions = new Set<number>()
    while (positions.size < 5) positions.add(Math.floor(Math.random() * words.length))
    const idx = [...positions].sort((a, b) => a - b)
    // Fisher-Yates shuffle of the 5 words for display
    const choices = idx.map(i => words[i])
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[choices[i], choices[j]] = [choices[j], choices[i]]
    }
    setQuizIdx(idx)
    setQuizChoices(choices)
    setQuizPicked([])
    setMode('confirm')
  }

  if (mode === 'menu') {
    return (
      <div className="wrap" style={{ paddingTop: addMode ? 30 : 70 }}>
        <div className="center" style={{ marginBottom: 28 }}>
          <div className="brand lg" style={{ justifyContent: 'center' }}>
            <img src="icons/logo.svg" alt="" />
            Beldex
          </div>
          {addMode ? (
            <h2 style={{ marginTop: 18, marginBottom: 6 }}>Add a wallet</h2>
          ) : (
            <>
              <h2 style={{ marginTop: 18, marginBottom: 6 }}>Privacy, in every transaction</h2>
              <p className="tagline">Keep your payments and identity private</p>
            </>
          )}
        </div>
        <button className="btn-primary" disabled={busy} onClick={async () => {
          setBusy(true)
          try { setPending(await createWallet()); setMode('create') }
          catch (e: any) { setError(e.message) }
          finally { setBusy(false) }
        }}>
          {busy ? 'Generating…' : 'Create new wallet'}
        </button>
        <div style={{ height: 10 }} />
        <button className="btn-ghost" style={{ width: '100%' }} onClick={() => setMode('restore')}>
          Restore from seed
        </button>
        {addMode && onCancel && (
          <>
            <div style={{ height: 10 }} />
            <button className="btn-ghost" style={{ width: '100%' }} onClick={onCancel}>Cancel</button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  if (mode === 'create' && pending) {
    return (
      <div className="wrap">
        <h2>Your recovery seed</h2>
        <div className="seed">{pending.mnemonic}</div>
        <p className="warn">
          ⚠ Write these 25 words down and store them safely. They are the only way to recover your funds.
        </p>
        <input placeholder="Wallet name (e.g. Savings)" value={name}
          onChange={e => setName(e.target.value)} />
        <input type="password" placeholder="Choose a password (min 8 chars)" value={password}
          onChange={e => setPassword(e.target.value)} />
        <StrengthHint password={password} />
        <input type="password" placeholder="Confirm password" value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)} />
        <button className="btn-primary" onClick={startQuiz}>
          I saved my seed — continue
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  if (mode === 'confirm' && pending) {
    const words = pending.mnemonic.trim().split(/\s+/)
    const nextSlot = quizPicked.length // which position is being filled next

    const check = () => {
      // compare by word text so duplicate words in the seed can't false-fail
      const wrong = quizIdx.filter((wordPos, i) =>
        quizChoices[quizPicked[i]].toLowerCase() !== words[wordPos].toLowerCase())
      if (wrong.length > 0) {
        setError(`Word${wrong.length > 1 ? 's' : ''} #${wrong.map(w => w + 1).join(', #')} ${wrong.length > 1 ? 'are' : 'is'} wrong — check your backup and try again`)
        setQuizPicked([])
        return
      }
      setError('')
      save(pending)
    }

    return (
      <div className="wrap">
        <h2>Confirm your seed</h2>
        <p className="muted">
          Tap the words below in this order:{' '}
          <b className="ok">{quizIdx.map(i => `#${i + 1}`).join(' → ')}</b>
        </p>

        {/* slots: one per requested position, filled as the user taps */}
        <div className="quiz-slots">
          {quizIdx.map((wordPos, i) => (
            <div key={wordPos} className={`quiz-slot ${i === nextSlot ? 'next' : ''}`}>
              <span className="muted">#{wordPos + 1}</span>
              <b>{quizPicked[i] !== undefined ? quizChoices[quizPicked[i]] : '—'}</b>
            </div>
          ))}
        </div>

        {/* shuffled word chips; tap to place into the next slot, tap again to undo */}
        <div className="quiz-words">
          {quizChoices.map((word, ci) => {
            const picked = quizPicked.includes(ci)
            return (
              <button key={ci} className={`word-chip ${picked ? 'picked' : ''}`}
                onClick={() => {
                  setError('')
                  setQuizPicked(picked
                    ? quizPicked.filter(p => p !== ci) // undo (later picks shift up)
                    : [...quizPicked, ci])
                }}>
                {word}
              </button>
            )
          })}
        </div>

        <div className="row">
          <button className="btn-ghost" onClick={() => { setError(''); setMode('create') }}>
            Back to seed
          </button>
          <button className="btn-primary" disabled={quizPicked.length !== quizIdx.length} onClick={check}>
            Confirm
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="wrap">
      <h2>Restore wallet</h2>
      <div style={{
        border: '1px solid var(--border)', borderLeft: '3px solid var(--green)',
        borderRadius: 6, padding: '10px 12px', marginBottom: 12, background: '#0d0d0d'
      }}>
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
          <b style={{ color: 'var(--green)' }}>Heads up — this is a light wallet.</b> It tracks
          activity from the moment you restore, so your <b>past balance and history won’t appear
          automatically</b>.
        </p>
        <p className="muted" style={{ margin: '8px 0 0', lineHeight: 1.55 }}>
          To bring your funds over: finish restoring here, then open your <b>existing</b> wallet
          and send your full balance to this wallet’s own address (a self-transfer). Your balance
          shows up here once that transaction confirms.
        </p>
      </div>
      <textarea rows={4} placeholder="Enter your 25-word recovery seed, words separated by spaces"
        style={{ minHeight: 96, lineHeight: 1.6, resize: 'vertical' }}
        value={mnemonic} onChange={e => setMnemonic(e.target.value)} />
      <input placeholder="Wallet name (e.g. Savings)" value={name}
        onChange={e => setName(e.target.value)} />
      <input type="password" placeholder="Choose a password (min 8 chars)" value={password}
        onChange={e => setPassword(e.target.value)} />
      <StrengthHint password={password} />
      <input type="password" placeholder="Confirm password" value={confirmPassword}
        onChange={e => setConfirmPassword(e.target.value)} />
      <div className="row">
        <button className="btn-ghost" onClick={() => { setError(''); setMode('menu') }}>Back</button>
        <button className="btn-primary" onClick={async () => {
          if (password !== confirmPassword) { setError('Passwords do not match'); return }
          try { await save(await restoreFromMnemonic(mnemonic.trim())) }
          catch (e: any) { setError(e.message) }
        }}>Restore</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
