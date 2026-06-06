import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, useLocation } from 'react-router-dom';
import '../style.css';

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const res = await axios.post('http://localhost:5000/login', { email, password });

      if (res.data.status === 'exist') {
        localStorage.setItem("isLoggedIn", "true");
        localStorage.setItem("userName", res.data.name || "User");
        localStorage.setItem("userEmail", email);
        
        // If they arrived via a share link, append the room queries back to workspace
        navigate(`/workspace${location.search}`);
      } else {
        setError('Invalid email or password.');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className='full'>
      <div className='container1'>
        <div className='header1'>
          <div className='text1'>Login</div>
          <div className='underline'></div>
        </div>
        <form onSubmit={handleLogin}>
          <div className='inputs1'>
            <div className='input1'>
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className='input1'>
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
          {error && <div className='error'>{error}</div>}
          <div className='btns1'>
            <input
              type="submit"
              value={isLoading ? 'Logging in...' : 'Submit'}
              id='submit'
              disabled={isLoading}
            />
          </div>
        </form>
        <div className='back-button-container'>
          <button className='back-button' onClick={() => navigate(`/signup${location.search}`)}>
            Create an account
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;