# pi-chat-runner

## Core Concepts

- チャット等のメッセージから pi-coding-agent を実行するための仕組み
- アプリケーションを単一のコンテナイメージで提供し、サーバレス環境でゼロスケールできるようにする
  - 常駐する複数のサービスを前提とせず、シンプルかつ低コストに運用できる
- エージェント自体は作らず、実行環境を整えて起動するだけ
  - プロンプトによる指示、Skill、MCP 等の一般的な拡張機構で目的を達成する
  - ユーザが追加・拡張できるようにし、特定の用途に限定しない


## Design

### Core Components

- Runner: メッセージの受信から応答までの流れを管理し、Session に応じて Agent を起動する
- Session: Agent との会話を表す単位。1 回の実行で完了することも、履歴と状態を引き継いで再開することもある
- Runtime: Agent の起動に必要なファイルシステム、設定、Skill を準備し、Agent プロセスを起動する実行環境
- Agent: Runtime で起動するコーディングエージェント。メッセージを処理し、reply tool を通して応答する
- State: 実行プロセスの外に保持する状態
  - Agent State: Agent が読み書きするファイルシステム上のデータ
  - Control State: Runner がメッセージの配送と Session の実行を制御するためのデータ

これらは以下のように動作する

- Runner はメッセージを受け取ると、Control State を参照して対応する Session を作成または再開する
- Runner は必要に応じて Agent State を復元し、Runtime を通して Agent を起動し、処理を終えると Agent State を保存する
- 複数の Session は、それぞれ独立した Runtime で並行して実行できるが、同じ Session では同時に 1 つの Agent だけを実行する
- Agent State と Control State を実行プロセスの外に保持するため、Runner の実行インスタンスが入れ替わっても Session を再開できる


### Pipeline

Runner は次の処理を順に行い、メッセージの受信から応答までをつなぐ。

- Ingress: メッセージを受け取り、チャットアプリケーションに依存しないデータ構造へ変換する
- Gate: メッセージを Agent の処理対象にするか判定する、複数の条件を AND、OR で組み合わせたり、LLM による判定を条件に含められる
- Inbox: Gate を通ったメッセージを保持する、Agent の起動や処理が失敗した場合もメッセージを保持し、重複した受信を吸収する
- Dispatcher: Inbox のメッセージを処理する Session を決め、Session を排他的に起動または再開する
- Agent: メッセージを処理し、reply tool を使って応答する
- Egress: Agent の応答について実際の送信先を解決し、チャットアプリケーションに応じたリクエストへ変換して送る

実行中の Session へのメッセージは Gate を常に通す設定を既定とし、必要に応じてメッセージごとに条件を評価できるようにする。チャットアプリケーション固有の API やデータ構造への依存は Ingress と Egress に閉じ込める。


### Session Model

Runner は、チャット上のメッセージを Agent の会話と実行に対応づけるため、Channel、Thread、Session、Turn を区別する。

- Channel: メッセージが流れてくる経路であり、Agent の設定を行う単位
  - 通常はチャットアプリケーション上のチャンネル、ルーム、DM などに対応する
- Thread: Channel 内でのメッセージの流れ
  - 例えば Slack ではチャンネルにメッセージ列が流れてくると同時に、メッセージに対する返信スレッドも存在する
- Session: Agent の会話の単位、会話履歴とファイルシステム上のデータを持ち、1 つ以上の Turn から構成される
  - 通常は Thread ごとに Session を作るが、Dispatcher が Thread と Session の対応を決める
- Turn: Agent に入力を渡してから、Agent が応答の完了を通知するまでの実行上の区切り
  - Turn は通常起動のきっかけになる 1 つのユーザのメッセージと、それに対する LLM の応答、Tool Call、steering のメッセージ等を含む

Channel 内のメッセージをどこまで一続きの会話として扱うかは、その Channel の用途によって異なる。例えば Slack のチャンネル直下で会話する場合は Channel 全体を 1 つの Thread として扱う。個別の依頼やアラートに対して返信する場合は、起点となるメッセージとその返信を 1 つの Thread として扱う。


### Message Dispatch

Dispatcher は、Inbox に届いたメッセージを処理する Session を決め、Agent への配送と Session の実行を制御する。この一連の処理を Message Dispatch と呼ぶ。Session は通常 Thread に対して作るが、Dispatcher により複数の Thread を束ねた Session を作成したり、同じ Thread から新たな Session を始める場合がある。Thread と Session の区切りが一致しないことは複雑さをもたらすが、実用上の利便性のために行う。

Message Dispatch には、Session の選択、メッセージの配送、Session の実行制御を行う以下の処理がある

- affinity: メッセージを既存の Session に合流させること
  - 目的: 別々の Thread に届いた一連のメッセージを、同じ会話として処理するため
- debounce: Agent へのメッセージの配送を短時間待ち、近接したメッセージをまとめること
  - 目的: 連続して届くメッセージごとに Agent を起動せず、1 つの Turn で処理するため
- steering: Turn を処理中の Agent に追加のメッセージを渡すこと
  - 目的: Agent の停止や返答を待たず、進行中の処理に追加入力するため
- lease: Session の実行を排他制御すること
  - 目的: 同じ Session を複数の Agent が同時に実行しないようにするため
- linger: Turn の終了後も Agent プロセスと lease を短時間維持すること
  - 目的: 続けて届くメッセージへの応答を速め、Agent の再起動と Agent State の復元を減らすため

具体的な状況を挙げると、Slack に流れてくるシステムのアラートを Agent が対応する状況を考える。
1 つのインシデントに対して、複数のモニタリングルールが反応し連続してアラートが発報される場合がある。メッセージごとに別々の Session を起動していると、一連のアラートを同じ文脈で処理できず Agent に十分な情報を渡せないまま複数の対応が走ってしまう。

このような場合 affinity の動作により、一連のアラートが 1 つの Session で処理される。瞬間的に連続して送信されたメッセージは debounce により 1 つの Turn でまとめて処理される。対応を始めた Agent の実行中にアラートが新たに届いたり、ユーザーから指示が与えられることもある。これらは steering として Agent の応答完了を待たずに文脈に追加される。この排他制御や実行の効率性のために lease や linger が必要になる。

近接したメッセージを同じ Session に合流させるだけでなく、分離するケースもある。古い Thread への追加メッセージを期限切れとみなす場合、明示的に新しい会話を始める場合、設定した終了条件を満たした場合には、新しい Session を作る。

Session の区切りと返信先は独立して扱う。各入力メッセージには対応する Thread Key を付与し、そのメッセージへの応答では同じ Thread Key を使うことを通常の動作とする。同じ Session に複数の Thread が含まれる場合、Agent は利用可能な Thread Key から返信先を選んで reply tool を呼び出せる。Runner は指定された Thread Key からチャットアプリケーション上の送信先を解決し、応答を送る。


### State

State は実行プロセスの外に保持し、用途に応じて Control State と Agent State に分け、Runner の実行インスタンスが入れ替わっても Session を再開できる構造にする。

- Control State: Runner がメッセージの配送と Session の実行を制御するためのデータ
  - Inbox、Thread と Session の対応、Session の実行状況、Lease など
- Agent State: Agent が読み書きするファイルシステム上のデータ
  - Session の Transcript と Workdir、Channel ごとの Shared

Control State はメッセージの配送や排他制御に応じて個別に参照、更新するため、データベースに保存する。
Agent State はファイルシステム上のデータを保存、復元する都合から、オブジェクトストレージに配置する。

Agent は Agent State のみをファイルシステムとして読み書きし、Control State にはアクセスしない。Control State は Runner が管理し、メッセージの配送と Session の実行にのみ使用する。


### Agent Runtime

Runtime は Workdir、環境変数、Channel の設定に応じた Skill やツールを Agent から利用できる状態にし、Agent を子プロセスとして起動する。

Agent は Runner の制御領域や認証情報から隔離する。

- Agent は Runner とは別の UID で起動し、Runner の所有するプロセス情報やファイルへのアクセスを制限する
- Runner と Agent でファイルシステムを共有するが、Agent が読み書きできるパスを制限する
- Agent に渡す環境変数は、明示的に許可したものに限る
- Channel ごとに opt-in で、Agent の外部ネットワークを FQDN の allowlist に絞る (srt。[runtime.md](design/runtime.md) §5.5)
- Agent には応答を返すための reply tool を与える。Runner 側が実際の返信先を解決するため、Agent はチャットアプリケーションの認証情報や送信方法に関与しない

Agent には、通常の動作環境と同様にファイルシステムを与える。

- Agent は Session ごとの Workdir を `cwd` として起動する
- Agent が書き込めるのは、Workdir と Channel 単位の共有ディレクトリである Shared に限る
- Workdir は `tmpfs` 上に置き、Agent の起動時に Agent State から復元し、実行の終了時に Agent State へ書き戻す
- 運用者が Agent にツールやコマンドを追加する場合は、実行環境またはコンテナイメージに追加し、設定で参照させる


### Config

設定は、システム全体の構成、Channel のメッセージ処理、Agent の動作に分ける。

- System Config: Runner を実行するための設定
  - チャットアプリケーションとの接続、State の保存先、Runtime の実装など
- Channel Config: Channel 単位の設定
  - Gate の条件、Thread と Session の対応、Message Dispatch、返信方法、Channel 固有の Agent Config など
- Agent Config: Agent の振る舞い、Runtime の設定
  - プロンプトとコンテキスト、利用モデル、利用する Tool、Skill、Pi Extension、環境変数など
  - default (共通の設定) を Channel ごとに上書きして Channel 固有の設定や動作を定義する


Channel Config では主に Gate (Agent の起動条件を設定) および Message Dispatch の設定を持つ。メッセージの内容や送信者などの条件を組み合わせて Agent を起動するか、どう Session を分けるかを決める。また各 Channel 固有の Agent Config を持つ。

実行中に変化する Channel の有効・無効、Thread と Session の対応、Session の実行状況は、設定ではなく Control State として扱う。Agent が利用できる CLI や共通の Skill など、追加のソフトウェアを必要とする能力はコンテナイメージに含め、Agent Config によって参照可能にする。


### Portability

特定の実行環境を前提とせず、デプロイしなくてもローカルで動作を確認できるようにする。

- メッセージングアプリケーションやインフラストラクチャは、差し替え可能なインタフェースを通して利用する
  - Slack と Google Cloud (Cloud Run、Firestore、Cloud Storage) を第一の想定動作環境として同梱する
  - State はローカルのファイルシステムや DB を System Config で設定することで、ローカルで動作確認を行えるように保つ
  - 確認用の簡易な TUI を提供する
- 実装は起動時に選択する。複数の実装を同時に使うことや、実行中に切り替えることは想定しない
- pi が提供する内部動作は pi の設定に委ね、Runner では再定義しない
  - モデルや Thinking Level の解釈、compaction、retry などは pi の機能を利用する
  - Channel や Agent ごとに変える項目は Agent Config で宣言し、Runner が起動時に pi へ渡す
