import React, { useState, useEffect } from 'react';
import './App.css';

const API_BASE = 'http://localhost:5000';
const MAX_PER_SYMBOL = 20;

const TICKER_ITEMS = [
  { sym: 'NVDA', price: '118.42', chg: '+2.34', up: true },
  { sym: 'AAPL', price: '172.18', chg: '+0.87', up: true },
  { sym: 'TSLA', price: '248.50', chg: '-3.12', up: false },
  { sym: 'AMD',  price: '155.30', chg: '+1.50', up: true },
  { sym: 'MSFT', price: '415.22', chg: '-0.45', up: false },
  { sym: 'GOOG', price: '174.90', chg: '+2.10', up: true },
  { sym: 'META', price: '508.77', chg: '+5.33', up: true },
  { sym: 'AMZN', price: '191.25', chg: '-1.22', up: false },
];

function TickerTape() {
  const items = [...TICKER_ITEMS, ...TICKER_ITEMS]; // duplicate for seamless loop
  return (
    <div className="ticker-wrap">
      <div className="ticker-tape">
        {items.map((t, i) => (
          <span key={i} className="ticker-item">
            <span className="sym">{t.sym}</span>
            {' '}{t.price}{' '}
            <span className={t.up ? 'up' : 'dn'}>{t.chg}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [symbol, setSymbol] = useState('');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');

  const [currentSymbol, setCurrentSymbol] = useState('');
  const [stockHistory, setStockHistory] = useState([]);
  const [trackedSymbols, setTrackedSymbols] = useState([]);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isTracking, setIsTracking] = useState(false);
  const [intervalTotal, setIntervalTotal] = useState(0);
  const [wasCleared, setWasCleared] = useState(false);

  const mergeHistory = (newEntries, sym, onlyLatest = false) => {
    setStockHistory(prev => {
      const others = prev.filter(e => e.symbol !== sym);
      const incoming = onlyLatest ? newEntries.slice(-1) : newEntries;
      const capped = incoming.slice(-MAX_PER_SYMBOL);
      return [...others, ...capped].sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
      );
    });
  };

  const fetchHistory = async (stockSymbol, onlyLatest = false) => {
    try {
      const response = await fetch(`${API_BASE}/history?symbol=${stockSymbol}`);
      if (!response.ok) return;
      const data = await response.json();
      mergeHistory(data.history, stockSymbol, onlyLatest);
    } catch (error) {
      console.error('Error fetching history:', error);
    }
  };

  const fetchAllHistory = async () => {
    try {
      const status = await fetch(`${API_BASE}/status`);
      if (!status.ok) return;
      const data = await status.json();
      for (const t of data.tracked) {
        await fetchHistory(t.symbol);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (symbol === '' || minutes === '' || seconds === '') {
      alert('Please fill in all fields');
      return;
    }
    const totalSeconds = parseInt(minutes) * 60 + parseInt(seconds);
    if (totalSeconds <= 0) {
      alert('Please enter a valid time');
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/start-monitoring`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.toUpperCase(),
          minutes: parseInt(minutes),
          seconds: parseInt(seconds),
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        alert(`Error: ${err.error}`);
        return;
      }
      const data = await response.json();
      setCurrentSymbol(data.symbol);
      setIntervalTotal(totalSeconds);
      setTimeRemaining(totalSeconds);
      setIsTracking(true);
      setWasCleared(false);
      setTrackedSymbols(prev =>
        prev.includes(data.symbol) ? prev : [...prev, data.symbol]
      );
      await fetchHistory(data.symbol);
    } catch (error) {
      alert('Could not connect to backend. Is the server running?');
    }
  };

  const handleRefresh = async () => {
    if (!currentSymbol) return;
    try {
      const response = await fetch(`${API_BASE}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: currentSymbol }),
      });
      if (!response.ok) {
        const err = await response.json();
        alert(`Refresh error: ${err.error}`);
        return;
      }
      await fetchHistory(currentSymbol, wasCleared);
      if (wasCleared) setWasCleared(false);
      setTimeRemaining(intervalTotal);
    } catch (error) {
      console.error('Error refreshing:', error);
    }
  };

  const handleStop = async () => {
    if (!currentSymbol) return;
    try {
      await fetch(`${API_BASE}/stop-monitoring`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: currentSymbol }),
      });
    } catch (error) {
      console.error('Error stopping:', error);
    }
    setIsTracking(false);
    setTimeRemaining(0);
  };

  const handleClear = () => {
    setStockHistory([]);
    setWasCleared(true);
  };

  const handleHistory = async () => {
    const target = symbol.trim().toUpperCase() || currentSymbol;
    if (!target && trackedSymbols.length === 0) {
      alert('Enter a symbol or start monitoring one first.');
      return;
    }
    if (target) {
      await fetchHistory(target);
    } else {
      await fetchAllHistory();
    }
  };

  useEffect(() => {
    let interval = null;
    if (isTracking && timeRemaining > 0) {
      interval = setInterval(() => setTimeRemaining(p => p - 1), 1000);
    } else if (isTracking && timeRemaining === 0 && currentSymbol) {
      fetchHistory(currentSymbol, false);
      setTimeRemaining(intervalTotal);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isTracking, timeRemaining, currentSymbol, intervalTotal]);

  const formatTime = (total) => {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="App">
      {/* Header */}
      <header className="app-header">
        <div className="header-logo">SCE</div>
        <h1>Stock <span>Tracker</span></h1>
        {isTracking && <div className="live-dot" title="Live" />}
      </header>

      {/* Ticker tape */}
      <TickerTape />

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="input-form">
        <div className="field-group">
          <span className="field-label">Minutes</span>
          <input
            type="number"
            placeholder="0"
            value={minutes}
            min="0"
            onChange={(e) => setMinutes(Math.max(0, parseInt(e.target.value) || 0))}
            className="input-field"
          />
        </div>
        <div className="field-group">
          <span className="field-label">Seconds</span>
          <input
            type="number"
            placeholder="0"
            value={seconds}
            min="0"
            onChange={(e) => setSeconds(Math.max(0, parseInt(e.target.value) || 0))}
            className="input-field"
          />
        </div>
        <div className="field-group">
          <span className="field-label">Symbol</span>
          <input
            type="text"
            placeholder="NVDA"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="input-field symbol-field"
          />
        </div>
        <button type="submit" className="submit-btn">Execute</button>
      </form>

      {/* Controls */}
      {isTracking && (
        <div className="controls">
          <span className="timer-label">Next update</span>
          <span className="timer-display">{formatTime(timeRemaining)}</span>
          <button onClick={handleRefresh} className="btn refresh-btn">↻ Refresh</button>
          <button onClick={handleStop}    className="btn stop-btn">■ Stop</button>
          <button onClick={handleHistory} className="btn history-btn">≡ History</button>
          <button onClick={handleClear}   className="btn clear-btn">✕ Clear</button>
        </div>
      )}

      {/* Table */}
      {stockHistory.length > 0 && (
        <div className="table-container">
          <table className="stock-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Open</th>
                <th>High</th>
                <th>Low</th>
                <th>Current</th>
                <th>Prev Close</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {stockHistory.map((entry, index) => (
                <tr key={index}>
                  <td className="sym-cell">{entry.symbol}</td>
                  <td>${entry.open.toFixed(2)}</td>
                  <td>${entry.high.toFixed(2)}</td>
                  <td>${entry.low.toFixed(2)}</td>
                  <td>${entry.current.toFixed(2)}</td>
                  <td>${entry.previousClose.toFixed(2)}</td>
                  <td>{new Date(entry.timestamp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default App;