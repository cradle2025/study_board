; StudyBoard 安装程序的自定义片段。
;
; ## 这个文件解决的问题
;
; electron-builder 默认在卸载 / 更新时把整个 `$INSTDIR` 递归删掉
; （模板里的 `RMDir /r $INSTDIR`）。而便携模式的数据目录
; `study-board-data` 就在程序同级目录里 —— 于是**任何一次更新都会
; 连用户的数据一起删掉**。这不是理论风险：安装程序把 `$INSTDIR` 里的
; 东西整体重命名到临时目录再删，`study-board-data` 一样在里面。
;
; ## 为什么不用 customRemoveFiles 接管删除
;
; 模板允许用 `customRemoveFiles` 整个替换删除逻辑，但那样会丢掉模板里
; 处理「文件被占用」的那套重命名 / 回滚机制（`un.atomicRMDir`）。
; 用一个自己写的递归删除去换掉它，等于把一份经过打磨的可靠性
; 换成一份没测过的。
;
; 所以这里走**挪出去再挪回来**：删除之前把它移到 `$TEMP`，
; 安装完成之后再移回原位。默认的删除逻辑一行都不用动。
;
; ## 只在更新时挪
;
; 用户主动卸载时不挪。数据在程序同级目录里，程序都没了，
; 留一个孤儿目录反而更让人困惑；这与 `deleteAppDataOnUninstall: false`
; 并不冲突 —— 那条管的是 `%APPDATA%` 里的常规数据目录，
; 它在卸载时本来就不会被碰。
;
; 万一挪出去之后安装失败了，数据还在 `$TEMP` 里没被删。
; 主进程启动时会做一次兜底：见 `paths.ts` 的 `rescueStashedPortableData`。

!define SB_PORTABLE_DIR "study-board-data"
!define SB_STASH_DIR "$TEMP\StudyBoard-portable-stash"

!macro customUnInstall
  ${if} ${isUpdated}
    IfFileExists "$INSTDIR\${SB_PORTABLE_DIR}\*.*" 0 sb_stash_done
      ; 上一轮如果留下了残骸，先清掉，免得 Rename 因为目标已存在而失败
      RMDir /r "${SB_STASH_DIR}"
      ClearErrors
      Rename "$INSTDIR\${SB_PORTABLE_DIR}" "${SB_STASH_DIR}"
      ${if} ${errors}
        ; 挪不动通常是文件被占用。**不动它**而不是硬删：
        ; 硬删就是我们要避免的那件事。留在原地至少还有机会被用户自己救回来
        DetailPrint "StudyBoard: 便携数据目录被占用，未能暂存"
      ${endif}
    sb_stash_done:
  ${endIf}
!macroend

!macro customInstall
  IfFileExists "${SB_STASH_DIR}\*.*" 0 sb_restore_done
    ; 新装的目录里理论上不会有它，但上一轮失败残留过就有可能
    RMDir /r "$INSTDIR\${SB_PORTABLE_DIR}"
    Rename "${SB_STASH_DIR}" "$INSTDIR\${SB_PORTABLE_DIR}"
    ${if} ${errors}
      DetailPrint "StudyBoard: 便携数据目录恢复失败，数据仍在 ${SB_STASH_DIR}"
    ${endif}
  sb_restore_done:
!macroend
