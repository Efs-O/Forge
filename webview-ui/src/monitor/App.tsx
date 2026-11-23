import React, { useEffect, useState } from 'react';
import type { MonitorHostToPanel, MonitorSnapshot } from '../../../src/monitor/monitorTypes';

declare function acquireVsCodeApi(): { postMessage(message: { type: 'ready' }): void };
export const MONITOR_CREDIT =
  "Card layout inspired by Strata's Monitor page (github.com/Niko1221/Strata, MIT).";

export const UPS_SETUP_HINT =
  'No UPS connected. To show one here, ask your AI agent to follow Step 12b of AI_SETUP.md (run Forge: Set Up With an AI Agent).';

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>();
  useEffect(() => {
    const vscode = acquireVsCodeApi();
    const listener = (event: MessageEvent<MonitorHostToPanel>): void => {
      if (event.data.type === 'monitorSnapshot') setSnapshot(event.data.snapshot);
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  return (
    <main className="monitor-root">
      <header>
        <h1>Forge Monitor</h1>
        <span>Live system and engine readings</span>
      </header>
      <div className="monitor-grid">
        {snapshot?.gpus.gpus.length ? (
          <section className="monitor-card">
            <h2>GPUs</h2>
            {snapshot.gpus.gpus.map((gpu) => (
              <div className="monitor-row" key={gpu.index}>
                <b>{gpu.name}</b>
                <span>
                  {gpu.utilizationPercent ?? '—'}% · {gpu.memoryUsedMb ?? '—'}/
                  {gpu.memoryTotalMb ?? '—'} MB · {gpu.temperatureC ?? '—'}°C
                </span>
              </div>
            ))}
          </section>
        ) : null}
        {snapshot?.gpus.error ? (
          <section className="monitor-card">
            <h2>GPUs</h2>
            <p>{snapshot.gpus.error}</p>
          </section>
        ) : null}
        {snapshot?.engines.map((engine) => (
          <section className="monitor-card" key={engine.name}>
            <h2>{engine.name}</h2>
            {Object.entries(engine.engine ?? {}).map(([key, value]) => (
              <div className="monitor-row" key={key}>
                <b>{key}</b>
                <span>
                  {value && typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </section>
        ))}
        {snapshot ? (
          <section className="monitor-card">
            <h2>Forge today</h2>
            <div className="monitor-row">
              <b>Turns</b>
              <span>{snapshot.forge.today.turns}</span>
            </div>
            <div className="monitor-row">
              <b>Requests</b>
              <span>{snapshot.forge.today.requests}</span>
            </div>
            <div className="monitor-row">
              <b>Tokens in / out</b>
              <span>
                {snapshot.forge.today.input_tokens} / {snapshot.forge.today.output_tokens}
              </span>
            </div>
            <div className="monitor-row">
              <b>Compactions</b>
              <span>{snapshot.forge.today.compactions}</span>
            </div>
            <div className="monitor-row">
              <b>Tool calls / failures</b>
              <span>
                {snapshot.forge.today.tool_calls} / {snapshot.forge.today.tool_failures}
              </span>
            </div>
            <div className="monitor-row">
              <b>Turn errors / without end</b>
              <span>
                {snapshot.forge.today.turn_errors} / {snapshot.forge.today.turns_without_end}
              </span>
            </div>
          </section>
        ) : null}
        {snapshot ? (
          <section className="monitor-card">
            <h2>UPS</h2>
            {!snapshot.ups ? (
              <p>{UPS_SETUP_HINT}</p>
            ) : snapshot.ups.error ? (
              <p>{snapshot.ups.error}</p>
            ) : (
              Object.entries(snapshot.ups.values).map(([key, value]) => (
                <div className="monitor-row" key={key}>
                  <b>{key}</b>
                  <span>{value}</span>
                </div>
              ))
            )}
          </section>
        ) : null}
      </div>
      <footer>{MONITOR_CREDIT}</footer>
    </main>
  );
}
