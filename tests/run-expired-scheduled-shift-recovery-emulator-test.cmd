@echo off
setlocal

call ".\node_modules\.bin\tsx.cmd" --test --test-concurrency=1 tests\expired-scheduled-shift-recovery-emulator.test.mts
set "TEST_EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %TEST_EXIT_CODE%
