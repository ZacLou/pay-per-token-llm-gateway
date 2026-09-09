import React from 'react';

const Skeleton: React.FC = () => {
  return (
    <div className="skeleton space-y-4">
      <div className="h-6 bg-gray-200 rounded w-1/2 animate-pulse" />
      <div className="h-4 bg-gray-200 rounded w-full animate-pulse" />
      <div className="h-4 bg-gray-200 rounded w-full animate-pulse" />
      <div className="h-4 bg-gray-200 rounded w-3/4 animate-pulse" />
    </div>
  );
};

export default Skeleton;
