import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommitStrategy, useScribe } from '@elevenlabs/react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { DraftState, VoiceCopilotAnswer } from '../../types';
import {
  answerVoiceQuery,
  getSuggestedCommands,
  getVoiceKeyterms,
  parseVoiceQuery,
  VOICE_COPILOT_COMMANDS,
  VoiceCopilotRules,
  VoiceCopilotScreen,
} from '../../utils/voiceCopilot';

interface VoiceCopilotProps {
  draftState: DraftState;
  divisionId: string;
  screen: VoiceCopilotScreen;
  rules: VoiceCopilotRules;
}

interface Exchange {
  id: number;
  question: string;
  answer: VoiceCopilotAnswer;
}

const tokenErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Only league admins can use the voice copilot.';
    if (error.status === 503) return 'Voice is not configured on this server.';
    if (error.status === 429) return 'Too many voice sessions started. Try again in a minute.';
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone access was blocked.';
  return 'Could not start the voice copilot.';
};

// Read-only: answers questions from draft state and never calls draft actions.
export const VoiceCopilot = ({ draftState, divisionId, screen, rules }: VoiceCopilotProps) => {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [readAloud, setReadAloud] = useState(true);
  const [typed, setTyped] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const nextId = useRef(1);

  const latest = useRef({ draftState, rules, readAloud });
  latest.current = { draftState, rules, readAloud };

  const scribeRef = useRef<ReturnType<typeof useScribe> | null>(null);

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const scribe = scribeRef.current;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    // Keep the mic from transcribing the readout back as a new question.
    if (scribe?.isConnected) scribe.mute();
    utterance.onend = utterance.onerror = () => {
      if (scribeRef.current?.isConnected) scribeRef.current.unmute();
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  const handleQuestion = useCallback((question: string, fromVoice: boolean) => {
    const text = question.trim();
    if (!text) return;
    const { draftState: state, rules: currentRules, readAloud: shouldSpeak } = latest.current;
    const answer = answerVoiceQuery(parseVoiceQuery(text, state), state, currentRules);
    // Table talk picked up by the mic is ignored instead of answered.
    if (fromVoice && answer.intent === 'unknown') return;
    setExchanges((prev) => [{ id: nextId.current++, question: text, answer }, ...prev].slice(0, 4));
    if (shouldSpeak) speak(answer.text);
  }, [speak]);

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    commitStrategy: CommitStrategy.VAD,
    onCommittedTranscript: ({ text }) => handleQuestion(text, true),
  });
  scribeRef.current = scribe;

  const isListening = scribe.isConnected;

  const startListening = async () => {
    setStartError(null);
    setIsStarting(true);
    try {
      const { token } = await api.getVoiceCopilotToken(divisionId);
      await scribe.connect({
        token,
        keyterms: getVoiceKeyterms(latest.current.draftState),
        microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      setStartError(tokenErrorMessage(error));
    } finally {
      setIsStarting(false);
    }
  };

  const stopListening = () => {
    scribe.disconnect();
    window.speechSynthesis?.cancel();
  };

  useEffect(() => () => {
    scribeRef.current?.disconnect();
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => {
    if (!readAloud && typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }, [readAloud]);

  const suggestions = useMemo(
    () => getSuggestedCommands(draftState, screen, rules),
    [draftState, screen, rules]
  );

  const scribeError = scribe.isConnected ? null : scribe.error;
  const error = startError ?? (scribeError && /device not found|notfound/i.test(scribeError)
    ? 'No microphone found. Connect one, or type a question.'
    : scribeError);

  return (
    <section
      aria-label="Voice copilot"
      // The draft board confirms a pending pick on Enter; keep Enter inside the copilot.
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.stopPropagation();
      }}
      className="bg-surface border border-rule rounded-sharp px-3 py-3 mb-4"
      data-testid="voice-copilot"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={isListening ? stopListening : startListening}
          disabled={isStarting}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-sharp text-xs font-semibold uppercase tracking-button transition-colors disabled:opacity-50 ${
            isListening ? 'bg-brand text-white' : 'bg-surface-2 text-ink hover:bg-surface-3'
          }`}
        >
          {isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          {isStarting ? 'Starting…' : isListening ? 'Stop listening' : 'Ask by voice'}
        </button>
        <button
          type="button"
          onClick={() => setReadAloud((prev) => !prev)}
          aria-pressed={readAloud}
          title={readAloud ? 'Answers are read aloud' : 'Answers are muted'}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-sharp text-xs text-ink-muted hover:text-ink"
        >
          {readAloud ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          {readAloud ? 'Read aloud' : 'Muted'}
        </button>
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
          Voice copilot · read-only
        </span>
        <form
          className="flex-1 min-w-[12rem]"
          onSubmit={(e) => {
            e.preventDefault();
            handleQuestion(typed, false);
            setTyped('');
          }}
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type a question"
            aria-label="Ask the voice copilot"
            className="w-full bg-surface-2 border border-rule rounded-sharp px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint"
          />
        </form>
      </div>

      {error && <p className="mt-2 text-xs text-red-600" role="alert">{error}</p>}

      {isListening && (
        <p className="mt-2 text-sm text-ink-muted italic" aria-live="polite">
          {scribe.partialTranscript || 'Listening…'}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint mr-1">Try</span>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => handleQuestion(suggestion, false)}
            className="px-2 py-1 rounded-sharp border border-rule text-xs text-ink hover:bg-surface-2"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <details className="mt-2 text-xs text-ink-muted">
        <summary className="cursor-pointer select-none">What I can answer</summary>
        <ul className="mt-1 ml-4 list-disc space-y-0.5">
          {VOICE_COPILOT_COMMANDS.map((command) => <li key={command}>{command}</li>)}
          <li>Picks, trades, undo and edits stay on the board's buttons.</li>
        </ul>
      </details>

      {exchanges.length > 0 && (
        <ol className="mt-3 space-y-2" aria-live="polite">
          {exchanges.map((exchange) => (
            <li key={exchange.id} className="text-sm">
              <div className="text-ink-faint">“{exchange.question}”</div>
              <div className="text-ink font-medium">{exchange.answer.text}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
