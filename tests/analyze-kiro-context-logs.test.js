import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    analyzeLogPaths,
    analyzeLogText,
    buildRemoteLogRequest,
    buildSshDockerLogsCommand,
    compareReports,
} from '../src/scripts/analyze-kiro-context-logs.js';

const SAMPLE_LOG = [
    '[2026-06-22 12:00:00.000] [Req:a] [INFO] [Kiro] History compression triggered: 761048 bytes > 580000 bytes (history entries: 700)',
    '[2026-06-22 12:00:00.010] [Req:a] [INFO] [Kiro] Tier-2 trim result: 761048 -> 620000 bytes, 700 -> 600 history entries, dropped 50 pure tool pairs',
    '[2026-06-22 12:00:00.020] [Req:a] [INFO] [Kiro] Tier-3 summary: compressing 588 old history entries via Kiro',
    '[2026-06-22 12:00:00.030] [Req:a] [INFO] [Kiro] Tier-3 summary prompt compacted: 588 history entries -> 28000 chars (pinnedFacts=36, toolEvents=48, transcriptExcerpts=64)',
    '[2026-06-22 12:00:01.000] [Req:a] [INFO] [Kiro] Tier-3 summary generated: 6001 chars (attempts=2, durationMs=990, fallback=none)',
    '[2026-06-22 12:00:01.010] [Req:a] [INFO] [Kiro] After Tier-3 compression: 620000 -> 500000 bytes (12 history entries)',
    '[2026-06-22 12:00:02.000] [Req:b] [INFO] [Kiro] Payload trimmed: 761048 -> 599085 bytes, 700 -> 551 history entries',
    '[2026-06-22 12:00:03.000] [Req:c] [ERROR] [Kiro] Stream API call failed (Status: 400, Code: ERR_BAD_REQUEST): Improperly formed request.',
].join('\n');

const IMPROVED_LOG = [
    '[2026-06-22 13:00:00.000] [Req:d] [INFO] [Kiro] History compression triggered: 700000 bytes > 580000 bytes (history entries: 620)',
    '[2026-06-22 13:00:00.010] [Req:d] [INFO] [Kiro] Tier-2 trim result: 700000 -> 610000 bytes, 620 -> 590 history entries, dropped 15 pure tool pairs',
    '[2026-06-22 13:00:00.020] [Req:d] [INFO] [Kiro] Tier-3 summary: compressing 578 old history entries via Kiro',
    '[2026-06-22 13:00:00.030] [Req:d] [INFO] [Kiro] Tier-3 summary prompt compacted: 578 history entries -> 16000 chars (pinnedFacts=20, toolEvents=30, transcriptExcerpts=40)',
    '[2026-06-22 13:00:00.250] [Req:d] [INFO] [Kiro] Tier-3 summary generated: 4200 chars (attempts=1, durationMs=230, fallback=none)',
    '[2026-06-22 13:00:00.260] [Req:d] [INFO] [Kiro] After Tier-3 compression: 610000 -> 510000 bytes (12 history entries)',
].join('\n');

const OLD_FORMAT_LOG = [
    '[2026-06-22 14:00:00.000] [Req:old-1] [INFO] [Kiro] Tier-3 summary: compressing 120 old history entries via Kiro',
    '[2026-06-22 14:00:01.250] [Req:old-1] [INFO] [Kiro] Tier-3 summary generated: 3800 chars',
].join('\n');

describe('analyze-kiro-context-logs', () => {
    test('parses Kiro context metrics from log text', () => {
        const report = analyzeLogText(SAMPLE_LOG, '<stdin>');

        expect(report.files).toEqual(['<stdin>']);
        expect(report.triggers.compressionTriggered).toBe(1);
        expect(report.triggers.payloadTrimmed).toBe(1);
        expect(report.triggers.improperRequestErrors).toBe(1);
        expect(report.triggers.upstreamErrors['400']).toBe(1);
        expect(report.latency.tier3DurationMs.p95).toBe(990);
        expect(report.contextFidelity.tier2DroppedPairs.max).toBe(50);
        expect(report.contextFidelity.tier3SummarisedEntries.max).toBe(588);
        expect(report.contextFidelity.tier3PromptChars.max).toBe(28000);
        expect(report.contextFidelity.tier3PromptPinnedFacts.max).toBe(36);
        expect(report.contextFidelity.tier3PromptToolEvents.max).toBe(48);
        expect(report.contextFidelity.tier3PromptTranscriptExcerpts.max).toBe(64);
        expect(report.contextFidelity.tier3SummaryChars.max).toBe(6001);
        expect(report.upstreamLimitSignals.payloadFinalBytes.max).toBe(599085);
        expect(report.assessment.parameterInteraction.status).toBe('warn');
        expect(report.assessment.upstreamLimitFit.status).toBe('warn');
        expect(report.assessment.latencyImpact.status).toBe('ok');
        expect(report.assessment.contextFidelity.status).toBe('warn');
    });

    test('parses all .log files from a directory', () => {
        const dir = mkdtempSync(join(tmpdir(), 'kiro-log-analysis-'));
        try {
            writeFileSync(join(dir, 'app-2026-06-22.log'), SAMPLE_LOG);
            writeFileSync(join(dir, 'ignore.txt'), SAMPLE_LOG);

            const report = analyzeLogPaths([dir]);

            expect(report.files).toEqual([join(dir, 'app-2026-06-22.log')]);
            expect(report.window.totalLines).toBe(8);
            expect(report.triggers.compressionTriggered).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('builds remote download request from base URL and token without leaking token into URL', () => {
        const request = buildRemoteLogRequest({
            baseUrl: 'https://example.com/',
            token: 'secret-token',
        });

        expect(request.url).toBe('https://example.com/api/system/download-log');
        expect(request.headers.Authorization).toBe('Bearer secret-token');
        expect(request.url).not.toContain('secret-token');
    });

    test('builds SSH docker logs command with container and time window', () => {
        const command = buildSshDockerLogsCommand({
            sshTarget: 'deploy@example.com',
            container: 'aiclient2api',
            since: '24h',
            tail: '5000',
        });

        expect(command.executable).toBe('ssh');
        expect(command.args).toContain('deploy@example.com');
        expect(command.args.join(' ')).toContain("'docker' 'logs' '--timestamps' '--since' '24h' '--tail' '5000' 'aiclient2api'");
    });

    test('compares before and after reports for impact assessment', () => {
        const before = analyzeLogText(SAMPLE_LOG, 'before.log');
        const after = analyzeLogText(IMPROVED_LOG, 'after.log');
        const comparison = compareReports(before, after);

        expect(comparison.deltas.limitErrors.status).toBe('improved');
        expect(comparison.deltas.tier3DurationP95Ms.status).toBe('improved');
        expect(comparison.deltas.tier3SummaryCharsP95.status).toBe('improved');
        expect(comparison.deltas.tier3PromptCharsP95.status).toBe('improved');
        expect(comparison.assessment.status).toBe('improved');
    });

    test('infers Tier-3 duration from old log timestamps when durationMs is absent', () => {
        const report = analyzeLogText(OLD_FORMAT_LOG, 'old-format.log');

        expect(report.triggers.tier3Started).toBe(1);
        expect(report.latency.tier3DurationMs.p95).toBe(1250);
        expect(report.contextFidelity.tier3Fallbacks.unknown_old_log_format).toBe(1);
    });
});
