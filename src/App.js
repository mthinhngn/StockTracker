import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  // State for form inputs
  const [symbol, setSymbol] = useState('');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');
  
  // State for tracking
  const [currentSymbol, setCurrentSymbol] = useState('');
  const [stockHistory, setStockHistory] = useState([]);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isTracking, setIsTracking] = useState(false);

  // API KEY 
  const API_KEY = 'd4gtmb1r01qgvvc54n50d4gtmb1r01qgvvc54n5g';

  // Function to fetch stock data
  const fetchStockData = async (stockSymbol) => {
    try {
      const response = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${stockSymbol}&token=${API_KEY}`
      );
      const data = await response.json();
      
      // Check if data is valid
      if (data.c === 0) {
        alert('Invalid stock symbol or market is closed');
        return null;
      }

      // Create a new entry with current timestamp
      const newEntry = {
        open: data.o,
        high: data.h,
        low: data.l,
        current: data.c,
        previousClose: data.pc,
        time: new Date().toLocaleString()
      };

      return newEntry;
    } catch (error) {
      console.error('Error fetching stock data:', error);
      alert('Error fetching stock data. Please try again.');
      return null;
    }
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!symbol || !minutes || !seconds) {
      alert('Please fill in all fields');
      return;
    }

    // Calculate total seconds
    const totalSeconds = (parseInt(minutes) * 60) + parseInt(seconds);
    
    if (totalSeconds <= 0) {
      alert('Please enter a valid time');
      return;
    }

    // Fetch initial data
    const initialData = await fetchStockData(symbol.toUpperCase());
    if (initialData) {
      setCurrentSymbol(symbol.toUpperCase());
      setStockHistory([initialData]);
      setTimeRemaining(totalSeconds);
      setIsTracking(true);
    }
  };

  // Handle manual refresh
  const handleRefresh = async () => {
    if (currentSymbol) {
      const newData = await fetchStockData(currentSymbol);
      if (newData) {
        setStockHistory(prev => [...prev, newData]);
      }
    }
  };

  // Timer effect
  useEffect(() => {
    let interval = null;

    if (isTracking && timeRemaining > 0) {
      interval = setInterval(() => {
        setTimeRemaining(prev => prev - 1);
      }, 1000);
    } else if (isTracking && timeRemaining === 0) {
      // Time's up - fetch new data and reset timer
      const totalSeconds = (parseInt(minutes) * 60) + parseInt(seconds);
      
      fetchStockData(currentSymbol).then(newData => {
        if (newData) {
          setStockHistory(prev => [...prev, newData]);
          setTimeRemaining(totalSeconds);
        }
      });
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isTracking, timeRemaining, currentSymbol, minutes, seconds]);

  // Format time remaining
  const formatTime = (totalSeconds) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="App">
      <h1>Stock Exchange - SCE's Financial Advising App</h1>
      
      {/* Input Form */}
      <form onSubmit={handleSubmit} className="input-form">
        <input
          type="number"
          placeholder="MIN"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          className="input-field"
        />
        <input
          type="number"
          placeholder="SEC"
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
          className="input-field"
        />
        <input
          type="text"
          placeholder="SYMBOL"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="input-field"
        />
        <button type="submit" className="submit-btn">SUBMIT</button>
      </form>

      {/* Timer and Refresh Button */}
      {isTracking && (
        <div className="controls">
          <p>Next update in: {formatTime(timeRemaining)}</p>
          <button onClick={handleRefresh} className="refresh-btn">
            Refresh Now
          </button>
        </div>
      )}

      {/* Stock Data Table */}
      {stockHistory.length > 0 && (
        <div className="table-container">
          <table className="stock-table">
            <thead>
              <tr>
                <th>Open Price</th>
                <th>High Price</th>
                <th>Low Price</th>
                <th>Current Price</th>
                <th>Previous Close Price</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {stockHistory.map((entry, index) => (
                <tr key={index}>
                  <td>${entry.open.toFixed(2)}</td>
                  <td>${entry.high.toFixed(2)}</td>
                  <td>${entry.low.toFixed(2)}</td>
                  <td>${entry.current.toFixed(2)}</td>
                  <td>${entry.previousClose.toFixed(2)}</td>
                  <td>{entry.time}</td>
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