FROM node:18-alpine

WORKDIR /app

# Copy ALL files from backend folder
COPY . .

# Install dependencies
RUN npm install

# Expose port
EXPOSE 5000

# Start app
CMD ["npm", "start"]