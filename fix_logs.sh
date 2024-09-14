# Copy logs from Azure log stream on the format below into log.txt and run the script
# 2024-09-13T17:21:01.0133575Z {"level":20,...
if ! test -f logs/log.txt; then
  echo "Add data to logs/log.txt"
  echo "2024-09-13T17:21:01.0133575Z {\"level\":20,..." > logs/log.txt
  return 0
fi
cat logs/log.txt | sed 's/^.\{29\}//g' | jq -s '.[] | .msg' > logs/messages.txt
touch logs/msg_json_lines.txt
echo "Log messages saved to logs/messages.txt"
