
@echo off

:: Step 2: Navigate to the path
cd /d "C:\Users\6106377\OneDrive - Thomson Reuters Incorporated\Tax Data Repository\TDR Application\a201694_otdr-app-tax-data-repository"

:: Step 3: Run snyk.exe
snyk.exe
timeout /t 5

:: Step 4: Authenticate Snyk
Snyk auth 0939f422-d475-4480-b841-da8f1bbff2e1
timeout /t 5

:: Step 5: Run snyk code test
echo Enter target-reference (e.g., release/0220250113-B):
set /p targetReference=
snyk code test --report --project-name="tr/a201694_otdr-tax-data-repository" --org=a66d4acc-7799-4599-9590-9eb1f64bd505 --target-reference=%targetReference%

pause

REM @echo off turns off the command echoing, which means that only the final output will be displayed in the command prompt.
REM cd /d navigates to the specified path.
REM snyk.exe runs the Snyk executable.
REM timeout /t 10 waits for 10 seconds to allow the previous command to complete.
REM Snyk auth authenticates Snyk with the provided token.
REM set /p targetReference= prompts the user to enter the target-reference.
REM snyk code test runs the Snyk code test with the provided parameters, including the user-input target-reference.
REM pause pauses the script to allow the user to review the output before closing the command prompt.