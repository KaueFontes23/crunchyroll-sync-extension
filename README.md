# Crunchyroll Sync — protótipo de extensão

Extensão Chrome Manifest V3 para sincronizar comandos normais de reprodução entre **duas participantes**, cada uma usando sua própria conta e perfil da Crunchyroll. A interface principal é o popup da extensão; não há site complementar.

> para os amantes de anime que desejam assistir together

O protótipo observa somente o elemento HTML de vídeo e os comandos usuais de reprodução. Ele não lê credenciais ou cookies, não acessa quadros ou áudio, não baixa, grava, copia ou retransmite vídeos e não tenta contornar DRM. A informação de que esse uso está autorizado foi fornecida pela usuária e é tratada como premissa do projeto.

## O que está implementado

- Criar sala **somente em uma página `/watch/<id>` com metadados do vídeo carregados**; o episódio dessa página é o episódio inicial da sala.
- Gerar um código de convite aleatório de 128 bits e copiar o código ou um link. Entrar continua sendo uma ação confirmada pelo botão do popup.
- Usar Firebase Authentication anônima, sem solicitar login da Crunchyroll, e exibir presença de no máximo duas identidades.
- Ao entrar na sala, direcionar a aba usada para inserir o código ao episódio atual da host.
- Enquanto as duas participantes estiverem na sala, seguir mudanças de episódio feitas por qualquer uma, mesmo que a sincronização de comandos de reprodução esteja parada. **Sair** da sala desativa o seguimento.
- Sincronizar play, pause, busca na linha do tempo e velocidade de reprodução depois que cada participante clicar explicitamente em **Iniciar sincronização**.
- Enviar batimentos de posição a cada 8 segundos enquanto o vídeo toca. Diferenças pequenas (acima de 0,75 s e até 3 s) podem ser corrigidas; atrasos maiores geram aviso, sem salto automático.
- Não aplicar comandos de reprodução enquanto a outra participante estiver em outro episódio; a aba segue o episódio da sala separadamente.
- Evitar ciclos usando UID de origem, IDs de comando, supressão de eventos e reconhecimento do `seeked` remoto correspondente.
- Se `play()` for bloqueado pelo navegador, mostrar um aviso para confirmação manual.
- Testar o sincronizador e regras do Realtime Database com Firebase Emulator Suite.

A sala guarda somente o **ID do episódio atual** (`episodeId`), o UID de origem e o horário da atualização; não guarda slug/título, query string, fragmento nem histórico de episódios. O ID corrente é usado para construir um destino fixo `https://www.crunchyroll.com/watch/<id>`.

## Requisitos

- Google Chrome 116 ou superior.
- Node.js 24.12 ou superior e npm.
- Java disponível para executar o Firebase Emulator Suite.
- Projeto Firebase no plano Spark para uso entre dispositivos/sessões. Não é necessário habilitar Blaze, criar hospedagem ou configurar servidor próprio.

## Preparar o Firebase no plano Spark

1. No [Firebase Console](https://console.firebase.google.com/), crie um projeto. Não habilite cobrança nem selecione upgrade para Blaze.
2. Adicione um app **Web** ao projeto apenas para obter a configuração do SDK. Não é necessário hospedar um site. Copie `apiKey`, `authDomain`, `projectId`, `appId` e a URL do Realtime Database.
3. Em **Authentication → Sign-in method**, habilite o provedor **Anonymous**. Não habilite nem informe credenciais da Crunchyroll.
4. Em **Realtime Database**, crie um banco no plano Spark. Comece no modo bloqueado e copie a URL completa apresentada pelo Console (normalmente termina em `firebaseio.com` ou `firebasedatabase.app`).
5. Na aba **Rules** do Realtime Database, substitua as regras pelo conteúdo de [`database.rules.json`](./database.rules.json) e publique as regras no Console. Não use regras abertas como `".read": true` ou `".write": true`.
6. Na pasta do projeto, copie `.env.example` para `.env.local` e preencha os campos do app Web e a URL real do banco. `.env.local` é ignorado pelo Git. Não coloque service-account JSON, chaves privadas ou outros segredos nesse arquivo.

A `apiKey` do app Web do Firebase não é uma chave privada; ela aparecerá no pacote local da extensão porque o SDK cliente a utiliza. A proteção depende das regras do banco, do Firebase Authentication e do segredo aleatório do convite, não de ocultar essa chave. Restrinja-a nas configurações do Google Cloud quando aplicável.

## Instalação, testes e build

Na raiz do projeto:

```bash
npm install
npm run test
npm run test:rules
npm run build
```

`npm run test:rules` inicia o emulador local de Realtime Database e executa os testes de regras. Usa o projeto de demonstração `demo-crsync`; não conecta nem grava dados no seu projeto Firebase real. O Java precisa estar disponível. Para executar tudo em sequência:

```bash
npm run test:all
```

O build gera a pasta `dist/` e verifica que o content script MV3 é um arquivo clássico autônomo, sem imports de módulo. Se alterar `.env.local`, rode `npm run build` novamente, pois os valores de configuração são incorporados ao pacote local.

## Carregar a extensão “unpacked”

1. Abra `chrome://extensions` no Chrome.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** (ou **Load unpacked**) e selecione a pasta `dist/`.
4. Abra ou recarregue uma página da Crunchyroll. Se a aba já estava aberta quando a extensão foi carregada ou atualizada, recarregue-a para o Chrome injetar o content script.
5. Clique no ícone da extensão para abrir o popup.

Depois de atualizar a extensão, clique em **Recarregar** no cartão dela em `chrome://extensions` e recarregue também a aba do episódio. Abas abertas antes da atualização podem continuar sem o content script novo.

## Testar em duas sessões

1. Use duas sessões independentes do Chrome, por exemplo, dois perfis de navegador. Instale a extensão nos dois. Cada pessoa entra na Crunchyroll por conta própria e no próprio perfil; a extensão não compartilha logins.
2. Na primeira sessão, abra o episódio específico desejado (`/watch/<id>`), aguarde o player carregar, abra o popup e clique em **Criar sala**. Em outras páginas ou sem vídeo ativo, a criação é recusada.
3. Copie o código ou o link de convite.
4. Na segunda sessão, abra o link recebido ou cole o código no popup e clique em **Entrar**. O link apenas preenche o código; a entrada continua sendo confirmada pelo botão. Ao entrar, a aba será redirecionada para o episódio inicial da sala.
5. Cada participante clica em **Iniciar sincronização** para compartilhar play, pause, busca e velocidade. Mudanças de episódio feitas por qualquer uma serão seguidas automaticamente enquanto ambas estiverem na sala.
6. Teste a troca de episódio em qualquer sessão. Se o navegador bloquear play automático, confirme manualmente a reprodução na aba indicada.
7. Use **Parar sincronização** para interromper somente os comandos de reprodução. Use **Sair** para remover sua presença e parar também o seguimento de episódios.

O link é `https://www.crunchyroll.com/?crsync_room=<código>`. Ao abri-lo, o Chrome pode redirecionar a URL; se o código não aparecer preenchido no popup, copie e cole manualmente. Nunca publique o convite: quem obtiver o código pode tentar entrar.

## Segurança e regras das salas

- O código de 128 bits é uma capacidade de acesso: quem o conhece pode solicitar entrada. Ele é usado como identificador da sala; não há uma lista pública de salas.
- As regras permitem acesso somente a membros autenticados da sala. Cada identidade só pode ocupar/retirar o próprio slot de participante; a sala comporta uma host e uma convidada.
- `currentEpisode` só pode ser lido por membros e atualizado por uma participante da sala, com autoria correspondente. As regras aceitam apenas um ID no formato alfanumérico/URL-safe e rejeitam campos extras. `mediaKey` só aceita identificadores de episódio ou caminhos internos, não URLs completas. A URL de destino é montada no cliente com domínio fixo da Crunchyroll; nenhum domínio vindo do banco é aberto.
- A criação em `/watch/<id>` com player pronto é verificada pela extensão no Chrome. Sem backend (não previsto no protótipo Spark), as regras Firebase não têm como provar qual página ou estado de player está aberto no navegador; essa precondição é uma validação de produto no cliente, não uma atestação anti-adulteração contra clientes modificados.
- A presença fica em `presence/<uid>` e é removida por `onDisconnect` quando a conexão cai. **Sair** também tenta remover presença e associação. Uma falha abrupta pode deixar o slot ocupado até a sala expirar, embora a presença seja removida pelo banco.
- Cada sala expira logicamente após 12 horas. As regras negam leitura/entrada/atualização após a expiração. No Spark sem backend não há processo confiável para apagar fisicamente todas as salas abandonadas; a limpeza física é manual em `rooms/<código>` na aba **Data** do Console Firebase.
- O estado temporário contém o último comando, posição, pausa/play, velocidade, UID anônimo, presença e um único ID do episódio atual. Não contém nomes, histórico de episódios, slugs, credenciais ou cookies.
- Teste as regras com `npm run test:rules` e publique as regras restritivas no Console antes de usar um projeto real.

## Limitações conhecidas

- Protótipo de duas identidades Firebase anônimas; o limite é de identidades, não de pessoas físicas. Desinstalar a extensão, limpar dados ou trocar de perfil pode criar um UID novo e deixar um slot antigo ocupado até a expiração. Nesse caso, crie uma nova sala ou remova a antiga no Console.
- A extensão atua somente em páginas HTTPS de `crunchyroll.com` e subdomínios e depende de um elemento HTML `<video>` acessível ao content script, com metadados carregados. Mudanças no site/player, regiões ou políticas do navegador podem exigir ajustes.
- O seguimento abre uma URL canônica `/watch/<id>` no domínio `www.crunchyroll.com`. A Crunchyroll pode redirecionar para outra rota regional ou exigir atualização do formato das rotas.
- O service worker MV3 pode ser suspenso pelo Chrome e reconectar após atividade; a continuidade em tempo real depende do navegador e da rede. Se necessário, pare e inicie de novo a sincronização de comandos.
- Correção automática de drift é limitada a até 3 segundos; atrasos maiores exigem ajuste manual. Alterações simultâneas de reprodução são resolvidas pelo último comando recebido.
- O seguimento automático só direciona para o ID do episódio publicado por uma participante da sala. A extensão não controla navegação geral, anúncios, legendas, qualidade, tela cheia ou controles específicos da Crunchyroll; não inclui chat, câmera ou microfone.
- Não há limpeza física automática de salas, site complementar, WebSocket próprio, deploy, publicação na Chrome Web Store nem criação/publicação de repositório GitHub.

## Solução de problemas

- **Popup diz “Config pendente”:** confirme que `.env.local` existe, não contém valores de exemplo, e rode `npm run build` novamente.
- **Falha de autenticação:** confirme que **Anonymous** está habilitado no Firebase Authentication e que o projeto está no plano esperado.
- **“Código inválido, sala cheia ou expirada”:** confira o código, as regras publicadas e se a sala ainda é válida. Salas antigas, criadas antes do nó `currentEpisode`, precisam ser recriadas.
- **Criação da sala recusada:** abra uma URL de episódio `/watch/<id>`, aguarde o player carregar os metadados do vídeo e tente novamente.
- **A extensão não encontra vídeo:** recarregue a aba depois de carregar a extensão e aguarde o player carregar.
- **A convidada não é redirecionada:** confira se ambas continuam conectadas à sala e se a extensão tem a versão atualizada; sair e entrar novamente pode restaurar a sessão.
- **Play automático bloqueado:** clique em play manualmente na aba afetada; o navegador controla essa permissão.
- **Teste de regras falha ao iniciar:** verifique se Java está instalado e se a porta local 9000 está livre.
