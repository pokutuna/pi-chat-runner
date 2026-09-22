// ink の色付け (chalk) は import 時に FORCE_COLOR を読んで色レベルを決める。
// テスト環境 (非 TTY) では色が全て落ちてしまい、フレームに ANSI スタイルが
// 一切現れないため、スタイルを検証したいテストファイルではこのモジュールを
// **他のどの import よりも先に** side-effect import して色を強制する
// (ESM の import は記述順に評価されるので、先頭に置けば chalk より先に走る)。
process.env.FORCE_COLOR = "3";
