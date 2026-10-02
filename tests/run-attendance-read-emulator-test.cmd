@echo off
setlocal

call ".\node_modules\.bin\tsx.cmd" --test --test-concurrency=1 tests\attendance-read-emulator.test.mts
set "TEST_EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %TEST_EXIT_CODE%