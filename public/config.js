/* ------------------------------------------------------------------ *
 * 録音チェッカーの設定ファイル
 *
 * 判定項目・しきい値・判定の文言・出口のURLは、すべてこのファイルにあります。
 * 数値や文言を直すときは、このファイルだけを書き換えれば足ります。
 * 計算のプログラム（js/ の中）は、数値をここから読んでいます。
 *
 * 書き方の約束
 * - stage（段階）は次のどれか
 *     1        … そのまま送れます
 *     2        … 直すともっと良くなります
 *     3        … このままだと受け取れません
 *                 （/mix/guide の「受けられないもの」に当たるときだけ使う）
 *     "check"  … 自動では決められないので、本人に確かめてもらう（頭出しで使う）
 *     "skip"   … このファイルでは確認できない
 * - 文言の中の {peak} のような部分は、計った値に置き換わります。
 *   使える名前は、各項目のコメントに書いてあります。
 * - しきい値の単位は名前の末尾で分かるようにしています。
 *     Db  … dBFS（0 がデジタルの最大。マイナスが大きいほど小さい音）
 *     Sec … 秒
 * - 「（仮）」と書いたしきい値は、手元の素材で合わせてから確定する値です。
 * ------------------------------------------------------------------ */

export default {
  /** 段階ごとの表示 */
  stages: {
    1: "そのまま送れます",
    2: "直すともっと良くなります",
    3: "このままだと受け取れません",
    check: "システムでは判断しきれません",
    skip: "確認できません",
  },

  /** 結果のいちばん上に出す一文。いちばん重い段階のものが出ます。 */
  summary: {
    3: "このままだと受け取れない項目があります",
    2: "直すともっと良くなる項目があります",
    check: "自動で見られる項目は、そのまま送れる状態です。「システムでは判断しきれません」の項目だけ見てください",
    1: "すべての項目が、そのまま送れる状態です",
    skip: "このファイルでは確認できる項目がありませんでした",
  },

  /** 直し方の行の頭に付く言葉 */
  fixLabel: "直し方",
  hintLabel: "確かめ方",

  /**
   * 項目のまとまり。並び順はこの順。
   * どのMIX師に出すときも同じ項目と、40HzP の指定に合わせた項目を分けています。
   */
  groups: [
    {
      id: "common",
      heading: "どのMIX師に出すときも共通",
      lead: "",
    },
    {
      id: "40hzp",
      heading: "40HzPに出すなら",
      lead: "MIX師によって指定の数値が違うことがあります。ほかの方に依頼するときは、その方の指定を優先してください。",
    },
  ],

  /** 読み込めるファイルの大きさの上限（MB）（仮） */
  maxFileMB: 300,

  /**
   * 音量を計る細かさ（ミリ秒）。頭出し・ノイズ・中身の判定は、
   * この長さごとの平均の音量で見ています。ふつうは触らなくて構いません。
   */
  windowMs: 20,

  /**
   * 判定項目。グループの中では、ここに書いた順に並びます。
   * id はプログラムが使う名前なので変えないでください。
   */
  items: [
    /* ---------------- どのMIX師に出すときも共通 ---------------- */

    {
      // 使える名前：{duration}（長さ） {peak}（いちばん大きいところ）
      id: "content",
      group: "common",
      name: "中身",
      minDurationSec: 10, // これより短いと「書き出し失敗の疑い」（仮）
      silentPeakDb: -50, // 全体でいちばん大きいところがこれより小さいと「ほぼ無音」（仮）
      outcomes: {
        ok: {
          stage: 1,
          detail: "長さ {duration}。音が入っています",
        },
        short: {
          stage: 2,
          detail: "長さが {duration} しかありません。書き出しに失敗している可能性があります",
          fix: "書き出す範囲を曲の最後まで広げて、書き出し直してください",
        },
        silent: {
          stage: 2,
          detail: "ほぼ無音です（いちばん大きいところで {peak}）。書き出しに失敗している可能性があります",
          fix: "ミュート・ソロの状態と、書き出すトラックを確かめて、書き出し直してください",
        },
        truncated: {
          stage: 2,
          detail: "ファイルが途中で切れているようです（{duration} まで読めました）",
          fix: "書き出し直すか、ファイルのコピーが最後まで終わっているか確かめてください",
        },
      },
    },

    {
      // 使える名前：{lead}（冒頭の無音の長さ） {diff}（伴奏との長さの差）
      //
      // 頭出しが「合っている」ことは自動では確かめられません。ボーカルには
      // 伴奏が入っていないので、位置を照らし合わせる手がかりが無いためです。
      // そのため「そのまま送れます」は出さず、典型的な失敗だけを拾います。
      //   ① 声がファイルの先頭からすぐ始まる（歌い出しから書き出した疑い）
      //   ② 伴奏より大幅に短い（伴奏を入れたときだけ見られる）
      // ①と②の両方に当てはまるときだけ likelyNotCued になります。
      id: "cueing",
      group: "common",
      name: "頭出し",
      voiceDb: -40, // これより大きい音が出たところを「声が始まった」とみなす（仮）
      aboveNoiseDb: 12, // ノイズが大きい録音では、ノイズよりこれだけ大きい音を声とみなす（仮）
      immediateStartSec: 1, // 先頭からこの秒数以内に声が始まると①に当たる（仮）
      shorterThanInstSec: 5, // 伴奏よりこの秒数以上短いと②に当たる（仮）
      sameLengthSec: 1, // 伴奏との差がこの秒数以内なら「長さは合っている」（仮）
      outcomes: {
        likelyNotCued: {
          stage: 3,
          detail: "声がファイルの先頭からすぐ始まっていて、伴奏より {diff} 短くなっています。頭出しされていない可能性が高いです",
          fix: "曲の先頭（0秒）から最後まで書き出し直してください",
        },
        sameLength: {
          stage: "check",
          detail: "長さは合っています。曲の先頭から書き出したかだけ確認してください",
        },
        shorter: {
          stage: "check",
          detail: "伴奏より {diff} 短くなっています。曲の先頭から書き出したかだけ確認してください",
          hint: "歌い終わりで書き出しを止めただけなら、このままで問題ありません",
        },
        longer: {
          stage: "check",
          detail: "伴奏より {diff} 長くなっています。曲の先頭から書き出したかだけ確認してください",
        },
        startsAtTop: {
          stage: "check",
          detail: "声がファイルの先頭からすぐ始まっています。イントロのない曲でなければ、頭出しされていない可能性があります",
          hint: "伴奏のファイルも入れると、長さを比べて確かめられます",
        },
        leadingSilence: {
          stage: "check",
          detail: "冒頭に {lead} の無音があります。曲の先頭から書き出したかだけ確認してください",
          hint: "伴奏のファイルも入れると、長さを比べて確かめられます",
        },
      },
      /** 伴奏を入れたのに長さが読めなかったとき、hint の代わりに出す */
      instUnreadable: "伴奏のファイルから長さを読み取れなかったため、長さは比べていません",
      /** いつも下に小さく出す注意書き */
      note: "数拍〜1小節のずれや、DAWで伴奏を0秒以外の位置に置いている場合は、ここでは見分けられません。",
    },

    {
      // 使える名前：{count}（潰れている箇所の数） {time}（最初の位置）
      //
      // 32bit float は 0dBFS を超えてもデータが残る形式なので、
      // 「超えている（データは残っている）」と「張り付いて潰れている」を分けています。
      id: "clipping",
      group: "common",
      name: "音割れ",
      minRunSamples: 4, // 最大値に張り付いたサンプルがこれだけ続いたら1か所と数える（仮）
      minCount: 1, // 潰れている箇所がこれ以上あれば「音割れあり」（仮）
      ignoreBelowDb: -12, // 最大値がこれより小さいときは数えない（小さい音での誤検出よけ）（仮）
      outcomes: {
        none: {
          stage: 1,
          detail: "見つかりませんでした",
        },
        clipped: {
          stage: 2,
          detail: "波形が最大値に張り付いて潰れているところが {count} か所あります（最初は {time} あたり）",
          fix: "入力（ゲイン）を下げて録り直すと直ります",
        },
        overButIntact: {
          stage: 1,
          detail: "0dBFS を超えているところがありますが、32bit float なのでデータは残っています（潰れてはいません）",
        },
      },
    },

    {
      // 使える名前：{peak}（いちばん大きいところ）
      id: "level",
      group: "common",
      name: "音量の余裕",
      minDb: -18, // いちばん大きいところがこれより小さいと「小さめ」（仮）
      maxDb: -3, // いちばん大きいところがこれより大きいと「余裕が少なめ」（仮）
      outcomes: {
        ok: {
          stage: 1,
          detail: "いちばん大きいところで {peak}",
        },
        low: {
          stage: 2,
          detail: "いちばん大きいところで {peak}。小さめです",
          fix: "入力（ゲイン）を少し上げて録ると、ノイズに埋もれにくくなります",
        },
        high: {
          stage: 2,
          detail: "いちばん大きいところで {peak}。余裕が少なめです",
          fix: "入力（ゲイン）を少し下げて録ると、声を張ったときも割れにくくなります",
        },
      },
    },

    {
      // 使える名前：{noise}（声の無い区間の雑音）
      //
      // 雑音は、声の無い区間（歌い出し前・フレーズの間・歌い終わり）だけで測る。
      // 声のある区間は前後に marginSec ずつ広げてから外す（息や響きの残りを拾わないため）。
      // 声のある・無いの境目は、頭出しの voiceDb / aboveNoiseDb と同じ基準。
      // ノイズ処理は料金に含まれるので、厳しくしすぎないこと。
      id: "noise",
      group: "common",
      name: "ノイズ",
      maxDb: -60, // 声の無い区間の雑音がこれより大きいと「大きめ」（仮）
      marginSec: 0.3, // 声のある区間の前後を、この秒数だけ声の無い区間から外す（仮）
      minQuietSec: 1, // 声の無い区間がこれより短いと「未測定」（仮）
      percentile: 10, // 声の境目を決めるための、おおよその雑音の位置（小さい順に下から何%）（仮）
      digitalSilenceDb: -90, // これより小さい区間は完全な無音（ノイズゲートや編集の跡）とみなし、計算から外す
      outcomes: {
        ok: {
          stage: 1,
          detail: "声の無い区間で {noise}",
        },
        high: {
          stage: 2,
          detail: "声の無い区間で {noise}。少し大きめです",
          fix: "エアコンやパソコンのファンを止めて録ると下がります",
        },
        // 息継ぎなしで歌い続けているなど、声の無い区間が見つからないとき
        noQuiet: {
          stage: "skip",
          detail: "未測定：声の無い区間が見つかりませんでした",
        },
        // 声の無い区間が完全な無音しかないとき（ノイズゲートや編集で消してある）
        zeroOnly: {
          stage: "skip",
          detail: "未測定：声の無い区間が完全な無音でした（ノイズゲートや編集の跡）",
        },
      },
      /** 完全な無音の区間を計算から外したとき、下に小さく出す */
      excludedNote: "完全な無音の区間（書き出しや編集で入ったもの）は、計算から外しています。",
    },

    {
      // フレーズの終わりで声が消えていく速さ（dB/秒）から推した目安。
      // 響く部屋ほど声が止まったあとも音が残り、下がり方が遅くなる。
      // 歌い方（音の切り方）の影響も混ざるので、精度は手元の素材で確かめること。
      id: "room",
      group: "common",
      name: "部屋の響き（目安）",
      fastDbPerSec: 150, // これより速く下がれば「少ない」（仮）
      slowDbPerSec: 70, // これより遅ければ「多い」（仮）
      minCount: 3, // 測れたフレーズの終わりがこれより少ないと「未測定」（仮）
      minGapSec: 0.3, // フレーズの後にこれだけ声の無い時間が続くところだけを使う（仮）
      lookbackSec: 0.2, // 終わる直前の音量を、この秒数さかのぼって探す
      maxTailSec: 1, // 終わってからこの秒数までを見る
      startDropDb: 5, // 直前の音量からこれだけ下がった所から測り始める
      endDropDb: 25, // 直前の音量からこれだけ下がった所まで測る（雑音より 6dB 上で打ち切り）
      minRangeDb: 30, // 直前の音量と雑音の差がこれより小さいフレーズは使わない
      outcomes: {
        low: {
          stage: 1,
          detail: "少ない",
        },
        normal: {
          stage: 1,
          detail: "普通",
        },
        high: {
          stage: 2,
          detail: "多い",
          fix: "布団やカーテンなど、柔らかいものを声の周りに置くと減ります",
        },
        notMeasured: {
          stage: "skip",
          detail: "未測定：フレーズの終わりを十分に見つけられませんでした",
        },
      },
      note: "フレーズの終わりで声が消えていく速さから推した目安です。",
    },

    /* ---------------- 40HzPに出すなら ---------------- */

    {
      // 使える名前：{name}（形式の名前）
      // outcomes の名前は形式ごと。ここに無い形式は other になります。
      id: "format",
      group: "40hzp",
      name: "ファイル形式",
      outcomes: {
        wav: {
          stage: 1,
          detail: "wav",
        },
        wavCompressed: {
          stage: 2,
          detail: "wav ですが、圧縮された種類です",
          fix: "非圧縮（PCM）の wav で書き出し直してください",
        },
        mp3: {
          stage: 2,
          detail: "mp3。このままでも受け取れます",
          fix: "wav で書き出すと、音質が落ちずに済みます",
        },
        m4a: {
          stage: 3,
          detail: "{name}",
          fix: "wav か mp3 に変換してから送ってください",
        },
        other: {
          stage: 2,
          detail: "{name}",
          fix: "wav で書き出し直してください",
        },
      },
      /** 拡張子と中身が違うとき、下に小さく出す */
      mismatch: "拡張子は .{ext} ですが、中身は {name} です",
    },

    {
      // 使える名前：{rate}
      id: "sampleRate",
      group: "40hzp",
      name: "サンプリング周波数",
      okHz: [48000], // そのまま送れる周波数
      outcomes: {
        ok: {
          stage: 1,
          detail: "{rate}",
        },
        other: {
          stage: 2,
          detail: "{rate}",
          fix: "録音時のプロジェクト設定と書き出しの設定で 48kHz を選んでください",
        },
      },
    },

    {
      // 使える名前：{depth}
      id: "bitDepth",
      group: "40hzp",
      name: "ビット深度",
      ok: ["32bit float", "24bit"], // そのまま送れるビット深度（画面の表記と同じ書き方）
      outcomes: {
        ok: {
          stage: 1,
          detail: "{depth}",
        },
        other: {
          stage: 2,
          detail: "{depth}",
          fix: "録音時のプロジェクト設定と書き出しの設定で 32bit float か 24bit を選んでください",
        },
      },
    },

    {
      // 使える名前：{count}（チャンネル数） {side}（音が入っている側）
      id: "channels",
      group: "40hzp",
      name: "チャンネル",
      sameDb: -50, // 左右の差がこれより小さいと「左右とも同じ音」
      oneSideDb: -40, // 片方がもう片方よりこれだけ小さいと「片側にしか入っていない」
      outcomes: {
        mono: {
          stage: 1,
          detail: "モノラル",
        },
        stereoSame: {
          stage: 2,
          detail: "ステレオ（左右とも同じ音）",
          fix: "モノラルで書き出し直してください",
        },
        stereoOneSide: {
          stage: 2,
          detail: "ステレオ（{side}にしか音が入っていません）",
          fix: "声が入っている側をモノラルで書き出し直してください",
        },
        stereoDifferent: {
          stage: 2,
          detail: "ステレオ（左右で音が違います）",
          fix: "エフェクトを外して、モノラルで書き出し直してください",
        },
        multi: {
          stage: 2,
          detail: "{count}チャンネル",
          fix: "モノラルで書き出し直してください",
        },
      },
    },
  ],

  /** 判定とは別に、結果の下にいつも出す注意書き */
  notes: [
    "結果は目安です。判定についての個別のご相談は受けていません。くわしい直し方は準備ガイドをご覧ください。",
    "40HzPでは、ケロケロ系のオートチューンをかけて録った音源は受けていません（ここでは判定していません）。",
    "歌の上手い下手や声質は見ていません。見ているのはデータの形だけです。",
  ],

  /** 画面に出すエラーなどの文言 */
  messages: {
    // 使える名前：{size}（ファイルの大きさ） {limit}（上限）
    tooLarge: "ファイルが大きすぎるため確認できません（{size}。上限は {limit} です）",
    unreadable: "音声ファイルとして読み取れませんでした。書き出し直したファイルで試してください",
    brokenWav: "wav として読み取れませんでした。ファイルが壊れている可能性があります。書き出し直したファイルで試してください",
    failed: "読み込みの途中で問題が起きました。もう一度ファイルを選んでください",
    // wav 以外を入れたとき、形式以外の項目に出す
    notWav: "wav 以外のファイルは、形式だけを見ています",
    // 圧縮された wav を入れたとき、形式以外の項目に出す
    undecodableWav: "この種類の wav は中身を読めないため、形式だけを見ています",
    // ほぼ無音のファイルで、音を見る項目に出す
    noSound: "音が入っていないため確認できません",
  },

  /** 結果の下に置く出口。サイトの中では何も売らない。 */
  exits: {
    heading: "次にすること",
    links: [
      {
        label: "MIX依頼の準備ガイドを読む",
        body: "書き出し方や頭出しのやり方を、手順でまとめています。",
        href: "https://40hzp.com/mix/guide",
        primary: false,
      },
      {
        label: "40HzPにMIXを依頼する",
        body: "40hzp.com のお問い合わせフォームが開きます。",
        href: "https://40hzp.com/?type=mix&utm_source=reccheck&utm_medium=result#contact",
        primary: true,
      },
    ],
  },

  /**
   * 前回との比較。同じブラウザでもう一度確かめたときだけ、結果の下に出す。
   * 前回の結果はこのブラウザの中（localStorage）にだけ残し、外には送らない。
   * key は記録の列名と同じ。部屋の響きの表示は、上の room の outcomes の detail を使う。
   */
  compare: {
    heading: "前回との比較",
    // 使える名前：{date}（前回の日時） {file}（前回のファイル名）
    lead: "前回（{date}・{file}）の結果と並べています。",
    columns: ["前回", "今回"],
    rows: [
      { key: "format", label: "ファイル形式" },
      { key: "sample_rate", label: "サンプリング周波数" },
      { key: "bit_depth", label: "ビット深度" },
      { key: "channels", label: "チャンネル" },
      { key: "duration_sec", label: "長さ" },
      { key: "peak_dbfs", label: "いちばん大きいところ" },
      { key: "clip_samples", label: "最大値に張り付いたサンプル" },
      { key: "noise_dbfs", label: "声の無い区間の雑音" },
      { key: "room", label: "部屋の響き（目安）" },
    ],
    empty: "—",
  },

  /** フッター */
  footer: {
    credit: { label: "企画 40HzP", href: "https://40hzp.com/?utm_source=reccheck&utm_medium=footer" },
    links: [
      { label: "声域測定", href: "https://voice.40hzp.com/?utm_source=reccheck&utm_medium=footer" },
    ],
    supportLabel: "支援",
    support: [
      { label: "PayPal", href: "https://www.paypal.com/ncp/payment/WJEJAWGWZQ2FL" },
      { label: "Gipt", href: "https://gi-pt.com/main/wishlist/fan-view/3a12acd6-e81d-25d2-5184-45865e890170" },
    ],
  },

  /* ------------------------------------------------------------------ *
   * 結果と機材の匿名の記録
   *
   * 結果の下の「記録する」を押したときだけ、判定の数値と機材名を送る。
   * 音声ファイル・ファイル名・IPアドレス・User-Agent は送らず、保存もしない。
   * ------------------------------------------------------------------ */
  record: {
    /**
     * Turnstile の Site Key（人に見せてよい値）。README「記録の準備」を参照。
     * 空のあいだは、記録の欄と「記録を消す」を画面に出さない。
     */
    turnstileSiteKey: "0x4AAAAAAGAdacSHHg80F0yV",

    endpoint: "/api/records",
    deleteEndpoint: "/api/records/delete",

    heading: "この結果と機材を記録する（任意）",
    lead: "機材ごとに「普通の部屋で録るとどうなるか」を貯めていくための記録です。記録しなくても、ここまでの結果はそのまま使えます。",
    /** 機材の欄。MIX依頼の事前アンケートと同じ5項目。column は下の columns の名前 */
    gear: [
      { column: "mic_raw", label: "マイク" },
      { column: "interface_raw", label: "オーディオインターフェース" },
      { column: "preamp_raw", label: "プリアンプ" },
      { column: "popfilter_raw", label: "ポップガード" },
      { column: "room_raw", label: "部屋" },
    ],
    gearHelp: "機種名だけを書いてください（各60字まで）。使っていないものは空欄で構いません。",
    /** 前回の結果があるときだけ聞く */
    changedQuestion: "前回から機材を変えましたか？",
    changedOptions: [
      { value: "yes", label: "変えた" },
      { value: "no", label: "変えていない" },
    ],
    submitLabel: "この結果と機材を匿名で記録する",
    deleteLabel: "このブラウザの記録を消す",
    deleteConfirm:
      "このブラウザから記録した数値と機材名を、すべて消します。前回の結果（このブラウザの中に残っているもの）も消えます。よろしいですか？",
    messages: {
      checking: "確認しています…",
      sending: "記録しています…",
      sent: "記録しました。ありがとうございます。",
      deleting: "消しています…",
      // 使える名前：{count}（消した件数）
      deleted: "このブラウザの記録を消しました（{count}件）。",
      turnstile: "確認がうまくいきませんでした。もう一度押してください。",
      failed: "記録できませんでした。時間をおいて、もう一度試してください。",
      deleteFailed: "消せませんでした。時間をおいて、もう一度試してください。",
    },

    /** ページ下部の「記録する内容」 */
    listHeading: "記録する内容",
    listLead: "結果の下の「記録する」を押したときだけ、次の内容を匿名で記録します。押さなければ何も送りません。",
    notRecordedLead: "次のものは送らず、記録もしません。",
    notRecorded: ["音声ファイル", "ファイル名", "IPアドレス", "ブラウザの種類（User-Agent）"],

    /**
     * 記録の列。データベースの表は、この一覧から自動で作られる（README「記録の準備」）。
     * - 列を足すときは末尾に足す。次の記録のときに自動で表に追加される
     * - 一度記録した列の名前や kind は変えない・消さない（前のデータと合わなくなる）
     * kind … text（文字）/ enum（values のどれか）/ uuid / stages（項目ごとの段階）
     *        / int（整数）/ real（小数）/ bool（はい・いいえ）
     * server … ブラウザからは受け取らず、受け口で入れる
     * label … ページ下部の「記録する内容」に出す説明
     */
    columns: [
      { name: "created_at", kind: "text", server: true, label: "記録した日時" },
      {
        name: "browser_id",
        kind: "uuid",
        required: true,
        label: "このブラウザの中で作った乱数（同じ人の機材を変える前と後を比べるためと、記録を消すために使います。個人は特定しません）",
      },
      { name: "app_version", kind: "text", max: 40, label: "判定のしかたの版" },
      { name: "format", kind: "text", max: 20, label: "ファイル形式" },
      { name: "sample_rate", kind: "int", label: "サンプリング周波数" },
      { name: "bit_depth", kind: "text", max: 20, label: "ビット深度" },
      { name: "channels", kind: "int", label: "チャンネル数" },
      { name: "peak_dbfs", kind: "real", label: "いちばん大きいところの音量" },
      { name: "clip_samples", kind: "int", label: "最大値に張り付いたサンプルの数" },
      { name: "noise_dbfs", kind: "real", label: "声の無い区間の雑音（測れなかったときは空）" },
      { name: "noise_excluded", kind: "bool", label: "完全な無音の区間を雑音の計算から外したか" },
      { name: "room", kind: "enum", values: ["low", "normal", "high"], label: "部屋の響きの目安" },
      { name: "duration_sec", kind: "real", label: "長さ" },
      { name: "results", kind: "stages", label: "項目ごとの判定の段階" },
      { name: "mic_raw", kind: "text", max: 60, label: "マイク（書いてもらった機種名）" },
      { name: "interface_raw", kind: "text", max: 60, label: "オーディオインターフェース（同上）" },
      { name: "preamp_raw", kind: "text", max: 60, label: "プリアンプ（同上）" },
      { name: "popfilter_raw", kind: "text", max: 60, label: "ポップガード（同上）" },
      { name: "room_raw", kind: "text", max: 60, label: "部屋（同上）" },
      { name: "gear_changed", kind: "enum", values: ["yes", "no", "unanswered"], label: "前回から機材を変えたか" },
    ],
  },
};
