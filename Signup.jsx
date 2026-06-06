import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import '../style.css';

const Signup = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError('');

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    try {
      setIsLoading(true);
      const res = await axios.post('http://localhost:5000/signup', { username, email, password });

      if (res.data.status === 'notexist') {
        alert('Sign up successful! Please log in.');
        navigate('/login');
      } else if (res.data.status === 'exist') {
        setError('Email already registered. Please use a different email.');
      } else {
        setError('An unexpected error occurred.');
      }
    } catch (err) {
      console.error('Error during signup:', err);
      setError(
        err.response?.data?.message || 'An error occurred. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className='auth-page-wrapper'>
      <div className='full'>
        <div className='container1'>
          <div className='header1'>
            <div className='text1'>Sign up</div>
            <div className='underline1'></div>
          </div>
          <form onSubmit={handleSignUp}>
            <div className='inputs1'>
              <div className='input1'>
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
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
                value={isLoading ? 'Submitting...' : 'Submit'}
                id='submit'
                disabled={isLoading}
              />
              <input
                type="button"
                value="Login"
                id='login'
                onClick={() => navigate('/login')}
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Signup;
