// HTTP uses native ES modules. The generated bundle also permits file:// use.
if (location.protocol === 'file:') {
  const script = document.createElement('script');
  script.src = 'js/app.bundle.js';
  document.body.append(script);
} else {
  import('./app.js').catch(error => {
    document.getElementById('boot-status').textContent = `Falha ao abrir o aplicativo: ${error.message}. Use o Live Server.`;
  });
}
