import { execFile } from 'node:child_process';
import express from 'express';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { summarizeText, sanitizeForTTS, sanitizeForNote } from '../text/summarization.js';

import { detectTextLanguage, languageOfLocale, pickVoiceForLanguage } from './language-detect.js';

// macOS `say` runs as a fixed executable with an argument array, never through
// a shell. Voice and rate are validated before it runs, and the text goes
// through stdin, so request text is spoken as data and never read as an option.
const SAY_VOICE_PATTERN = /^[A-Za-z0-9()._][A-Za-z0-9 ()._-]{0,63}$/;
const SAY_RATE_MIN = 50;
const SAY_RATE_MAX = 500;

// Number.isFinite never coerces, so a string rate is refused too.
const isValidSayRate = (rate) => Number.isFinite(rate) && rate >= SAY_RATE_MIN && rate <= SAY_RATE_MAX;

// An installed-voice list from `say -v '?'` is authoritative; without one only the pattern applies.
const isAllowedSayVoice = (voice, voices) => (
  SAY_VOICE_PATTERN.test(voice) && (voices.length === 0 || voices.some((entry) => entry?.name === voice))
);

const runSay = ({ voice, rate, outputFile, text }) => new Promise((resolve, reject) => {
  const child = execFile('say', ['-v', voice, '-r', String(rate), '-o', outputFile, '--data-format=aac'], (error) => {
    if (error) reject(error);
    else resolve();
  });
  // say may exit before reading all of stdin; its exit status reports the failure.
  child.stdin.on('error', () => {});
  child.stdin.end(text);
});

export function registerTtsRoutes(app, { sayTTSCapability, platform = process.platform }) {
  let ttsModulePromise = null;
  const getTtsModule = async () => {
    if (!ttsModulePromise) {
      ttsModulePromise = import('./index.js');
    }
    return ttsModulePromise;
  };

  app.post('/api/voice/token', async (req, res) => {
    console.log('[Voice] Token request received:', {
      contentType: req.headers['content-type'] || null,
    });
    try {
      const openaiApiKey = process.env.OPENAI_API_KEY;
      console.log('[Voice] OpenAI API Key present:', !!openaiApiKey);

      if (!openaiApiKey) {
        return res.status(503).json({
          allowed: false,
          error: 'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.'
        });
      }

      // Return success - OpenAI TTS is available
      res.json({
        allowed: true,
        provider: 'openai',
        message: 'OpenAI TTS is available'
      });
    } catch (error) {
      console.error('[Voice] Token generation error:', error);
      res.status(500).json({
        allowed: false,
        error: 'Voice service error'
      });
    }
  });

  // Server-side TTS endpoint - streams audio from OpenAI TTS API
  app.post('/api/tts/speak', async (req, res) => {
    try {
      const { text, voice = 'nova', model = 'gpt-4o-mini-tts', speed = 0.9, instructions, providerId, modelId, apiKey, baseURL } = req.body || {};

      const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
      if (normalizedBaseURLResult.error) {
        return res.status(400).json({ error: normalizedBaseURLResult.error });
      }
      const normalizedBaseURL = normalizedBaseURLResult.value;

      console.log('[TTS] Request received:', { voice, model, speed, textLength: text?.length, hasApiKey: !!apiKey, hasBaseURL: !!baseURL });

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      // Dynamically import the TTS service (ESM)
      const { ttsService } = await getTtsModule();

      // Check availability - server-configured key, client-provided key, or custom server URL
      const hasServerKey = ttsService.isAvailable();
      const hasClientKey = apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0;
      const hasCustomBaseURL = typeof normalizedBaseURL === 'string' && normalizedBaseURL.length > 0;
      
      if (!hasServerKey && !hasClientKey && !hasCustomBaseURL) {
        return res.status(503).json({ 
          error: 'TTS service not available. Please configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.' 
        });
      }

      let textToSpeak = text.trim();

      // Historical summarize request fields are intentionally ignored. The
      // model-backed summarization provider is retired.

      const result = await ttsService.generateSpeechStream({
        text: textToSpeak,
        voice,
        model,
        speed,
        instructions,
        apiKey: hasClientKey ? apiKey.trim() : undefined,
        baseURL: hasCustomBaseURL ? normalizedBaseURL : undefined,
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
      } catch (error) {
        console.error('[TTS] Error:', error);
        if (!res.headersSent) {
          const { model: m, voice: v, baseURL: b } = req.body || {};
          res.status(500).json({ 
            error: error instanceof Error ? error.message : 'TTS generation failed',
            detail: { model: m, voice: v, hasBaseURL: !!b },
          });
        }
      }
  });

  app.post('/api/text/summarize', async (req, res) => {
    try {
      const { text, threshold = 200, maxLength = 500, mode } = req.body || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const result = await summarizeText({
        text,
        threshold,
        maxLength,
        mode: typeof mode === 'string' ? mode : 'tts',
      });

      return res.json(result);
    } catch (error) {
      console.error('[Summarize] Error:', error);
      const sanitized = typeof req.body?.mode === 'string' && req.body.mode === 'note'
        ? sanitizeForNote(req.body?.text || '')
        : sanitizeForTTS(req.body?.text || '');
      return res.json({ summary: sanitized, summarized: false, reason: error.message });
    }
  });

       
  // TTS status endpoint
  app.get('/api/tts/status', async (_req, res) => {
    try {
      const { ttsService } = await getTtsModule();
      res.json({
        available: ttsService.isAvailable(),
        voices: [
          'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
          'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
        ]
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check TTS status' });
    }
  });

  // The startup probe runs concurrently with server bootstrap. An unusually
  // early status request waits for that same authoritative result.
  app.get('/api/tts/say/status', async (_req, res) => {
    res.json(await sayTTSCapability);
  });

  // macOS 'say' command TTS speak endpoint
  app.post('/api/tts/say/speak', async (req, res) => {
    try {
      const { text, rate = 200, language, languageSample } = req.body || {};
      let voice = typeof req.body?.voice === 'string' && req.body.voice.trim() ? req.body.voice.trim() : 'Samantha';
      
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const capability = await sayTTSCapability;
      const voices = Array.isArray(capability?.voices) ? capability.voices : [];
      if (!isValidSayRate(rate)) {
        return res.status(400).json({ error: `rate must be a number from ${SAY_RATE_MIN} to ${SAY_RATE_MAX}` });
      }
      if (!isAllowedSayVoice(voice, voices)) {
        return res.status(400).json({ error: 'voice must be an installed say voice' });
      }
      
      // Check if we're on macOS
      if (platform !== 'darwin') {
        return res.status(503).json({ error: 'macOS say command not available on this platform' });
      }

      // `language: 'auto'`: keep the chosen voice while it speaks the text's
      // language, otherwise switch to an installed voice that does. A
      // language with no installed voice keeps the chosen voice — say still
      // reads the text, just with an accent — rather than failing.
      let resolvedLanguage = null;
      if (language === 'auto') {
        const sample = typeof languageSample === 'string' && languageSample.trim() ? languageSample.slice(0, 4000) : text;
        resolvedLanguage = detectTextLanguage(sample).language;
        const chosen = voices.find((entry) => entry.name === voice);
        if (languageOfLocale(chosen?.locale) !== resolvedLanguage) {
          const match = pickVoiceForLanguage(resolvedLanguage, voices);
          if (match) voice = match;
        }
      }
      
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      
      // Create temp file for audio output (use m4a for browser compatibility)
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `say-${Date.now()}.m4a`);
      
      // Generate audio file using 'say' command
      // -o outputs to file, -r sets rate (words per minute)
      // --data-format=aac outputs as m4a which browsers can decode
      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate });
      
      await runSay({ voice, rate, outputFile: tempFile, text: text.trim() });
      
      // Read the generated audio file
      const audioBuffer = await fs.promises.readFile(tempFile);
      
      // Clean up temp file
      fs.promises.unlink(tempFile).catch(() => {});
      
      // Send audio response
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('X-Speech-Voice', voice);
      if (resolvedLanguage) res.setHeader('X-Speech-Language', resolvedLanguage);
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
      
    } catch (error) {
      console.error('[TTS-Say] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Say command failed'
      });
    }
  });

  // Server-side STT: receive raw audio, proxy to OpenAI-compatible transcription endpoint
  app.post(
    '/api/stt/transcribe',
    express.raw({ type: (req) => (req.headers['content-type'] || '').startsWith('audio/'), limit: '20mb' }),
    async (req, res) => {
      try {
        const { transcribeAudio } = await import('./stt.js');

        const mimeType = (req.headers['content-type'] || 'audio/webm').split(',')[0].trim();
        const baseURL = typeof req.headers['x-base-url'] === 'string' ? req.headers['x-base-url'].trim() : '';
        const model = typeof req.headers['x-model'] === 'string' && req.headers['x-model'].trim().length > 0
          ? req.headers['x-model'].trim()
          : 'deepdml/faster-whisper-large-v3-turbo-ct2';
        const language = typeof req.headers['x-language'] === 'string' && req.headers['x-language'].trim().length > 0
          ? req.headers['x-language'].trim()
          : undefined;
        const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].trim() : '';
        const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }

        if (!baseURL) {
          return res.status(400).json({ error: 'X-Base-URL header is required' });
        }

        console.log('[STT] Transcribing audio:', {
          bytes: req.body.length,
          mimeType,
          model,
          baseURL,
          language,
          hasApiKey: !!apiKey,
        });

        const transcript = await transcribeAudio({
          audioBuffer: req.body,
          mimeType,
          model,
          baseURL,
          apiKey,
          language,
        });

        console.log('[STT] Transcript:', transcript?.slice(0, 120));
        res.json({ transcript: transcript ?? '' });
      } catch (error) {
        console.error('[STT] Error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Transcription failed',
          });
        }
      }
    }
  );
}
