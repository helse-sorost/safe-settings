# Copy content of log messages (e.g. output of fix_logs.sh) that are in JSON format into msg_json_lines.txt and run the script, e.g.:
# [{\"name\":\"admins\",\"permission\":\"push\"},{\"name\":\"admin-codeowner\",\"permission\":\"maintain\"},{\"name\":\"admin-codeowner-github\",\"permission\":\"pull\"}]
cat logs/msg_json_lines.txt | sed 's/\\"/"/g' | jq -s > logs/messages.json
