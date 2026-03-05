document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const error = document.getElementById('loginError');
  const password = document.getElementById('password').value;

  btn.disabled = true;
  btn.textContent = '…';
  error.hidden = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = '/';
    } else {
      const data = await res.json();
      error.textContent = data.error || 'Wrong password';
      error.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Enter';
    }
  } catch {
    error.textContent = 'Connection error. Try again.';
    error.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Enter';
  }
});
