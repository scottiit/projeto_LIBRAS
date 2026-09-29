// Training writes to dataset_libras.csv through the local Node server.
if (location.protocol === 'file:') {
  const banner = document.createElement('section');
  banner.className = 'capture-panel';
  const heading = document.createElement('h2'); heading.textContent = 'Levar exemplos antigos para o CSV';
  const explanation = document.createElement('p');
  explanation.textContent = 'Este endereço local pode conter seus exemplos antigos. Exporte-os aqui, execute npm start e abra http://127.0.0.1:5173. No Treinamento do mesmo perfil, importe o arquivo gerado.';
  const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'Exportar exemplos antigos (JSON)';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  button.addEventListener('click', () => {
    try {
      const profiles = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith('libras:v1:profile:')) continue;
        const profile = JSON.parse(localStorage.getItem(key));
        if (profile?.version === 1 && typeof profile.name === 'string') profiles.push({
          name: profile.name,
          signExamples: profile.signExamples,
          motionExamples: profile.motionExamples,
          pendingExamples: profile.pendingExamples,
        });
      }
      if (!profiles.length) { status.textContent = 'Nenhum perfil antigo encontrado neste endereço.'; return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, kind: 'libras-browser-profiles', profiles })], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'libras-perfis-antigos.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `${profiles.length} perfil(is) exportado(s). Abra o aplicativo pelo servidor Node e importe este JSON no Treinamento de cada perfil.`;
    } catch (error) { status.textContent = `Não foi possível exportar os perfis deste endereço: ${error.message}`; }
  });
  banner.append(heading, explanation, button, status);
  document.querySelector('#profile-screen').prepend(banner);
  document.getElementById('boot-status').textContent = 'O treinamento agora exige o servidor Node local para gravar em dataset_libras.csv.';
} else {
  import('./app.js').catch(error => {
    document.getElementById('boot-status').textContent = `Falha ao abrir o aplicativo: ${error.message}. Execute npm start.`;
  });
}
